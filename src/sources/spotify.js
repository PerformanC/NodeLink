import https from 'https'
import zlib from 'zlib'

import utils from '../utils.js'
import searchWithDefault from './default.js'

let playerInfo = {}

async function setSpotifyToken() {
  const token = await utils.nodelink_makeRequest('https://open.spotify.com/get_access_token', {
    method: 'GET'
  })

  const req = https.request({
    hostname: 'clienttoken.spotify.com',
    path: '/v1/clienttoken',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://open.spotify.com/',
      'Content-Type': 'application/json',
      'Origin': 'https://open.spotify.com',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site'
    }
  }, (res) => {
    let data = ''

    const compression = zlib.createGunzip()
    res.pipe(compression)
  
    compression.on('data', (chunk) => data += chunk)
  
    compression.on('end', () => {
      data = JSON.parse(data)

      if (data.response_type == 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
        playerInfo = {
          accessToken: token.accessToken,
          clientToken: data.granted_token.token
        }
      }
    })
  })
  
  req.on('error', (error) => {
    console.error(error)
  })
  
  req.write(JSON.stringify({
    client_data: {
      client_version: '1.2.9.2269.g2fe25d39',
      client_id: 'd8a5ed958d274c2e8ee717e6a4b0971d',
      js_sdk_data: {
        device_brand: 'unknown',
        device_model: 'unknown',
        os: 'linux',
        os_version: 'unknown',
        device_id: '0c5f7c36-855e-4d0a-a661-1a79958ee6de',
        device_type: 'computer'
      }
    }
  }))
  req.end()
}

async function search(query) {
  return new Promise(async (resolve) => {
    https.get({
      hostname: 'api-partner.spotify.com',
      path: `/pathfinder/v1/query?operationName=searchDesktop&variables=%7B%22searchTerm%22%3A%22${encodeURI(query)}%22%2C%22offset%22%3A0%2C%22limit%22%3A10%2C%22numberOfTopResults%22%3A5%2C%22includeAudiobooks%22%3Atrue%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%221d3a8f81abf4f33f49d1e389ed0956761af669eedb62a050c6c7bce5c66070bb%22%7D%7D`,
      method: 'GET',
      headers: {
        'Host': 'api-partner.spotify.com',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://open.spotify.com/',
        'authorization': `Bearer ${playerInfo.accessToken}`,
        'app-platform': 'WebPlayer',
        'spotify-app-version': '1.2.9.1649.gd4540f47',
        'content-type': 'application/json;charset=UTF-8',
        'client-token': playerInfo.clientToken,
        'Origin': 'https://open.spotify.com',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    }, (res) => {
      let data = ''

      const compression = zlib.createGunzip()
      res.pipe(compression)
    
      compression.on('data', (chunk) => data += chunk)
    
      compression.on('end', () => {
        data = JSON.parse(data)

        if (data.data.searchV2.tracksV2.totalCount == 0)
          return resolve({ loadType: 'empty', data: {} })
          
        let tracks = []
        let i = 0

        data.data.searchV2.tracksV2.items.forEach(async (track, index) => {
          if (track) {
            track = track.item.data

            const search = await searchWithDefault(`${track.name} ${track.artists.items[0].profile.name}`)

            if (search.loadType == 'empty')
              return resolve(search)

            const infoObj = {
              identifier: search.tracks[0].info.identifier,
              isSeekable: true,
              author: track.artists.items.map((artist) => artist.profile.name).join(', '),
              length: track.duration.totalMilliseconds,
              isStream: false,
              position: i++,
              title: track.name,
              uri: track.uri,
              artworkUrl: track.albumOfTrack.coverArt.sources[0].url,
              isrc: null,
              sourceName: 'spotify'
            }

            tracks.push({
              encoded: utils.nodelink_encodeTrack(infoObj),
              info: infoObj,
              pluginInfo: {}
            })
          }

          if (index == data.data.searchV2.tracksV2.items.length - 1)
            resolve({
              loadType: 'search',
              data: tracks
            })
        })
      })
    })
  })    
}

async function loadFrom(query, type) {
  return new Promise(async (resolve) => {
    let endpoint

    switch (type[1]) {
      case 'track': {
        endpoint = `/tracks/${type[2]}`
        break
      }
      case 'playlist': {
        endpoint = `/playlists/${type[2]}`
        break
      }
      case 'album': {
        endpoint = `/albums/${type[2]}`
        break
      }
      case 'episodes': {
        endpoint = `/episodes/${type[2]}?market=${Infos.Configs.SpotifyMarket}`
        break
      }
      case 'show': {
        endpoint = `/shows/${type[2]}?market=US`
        break
      }
      default: {
        return resolve({ loadType: 'empty', data: {} })
      }
    }

    console.log(`[NodeLink]: Loading track from Spotify: ${endpoint}`)

    let data = await utils.nodelink_makeRequest(`https://api.spotify.com/v1${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${playerInfo.accessToken}`
      }
    })

    if (data.error) {
      if (data.error.status == 401) {
        setSpotifyToken()

        data = await utils.nodelink_makeRequest(`https://api.spotify.com/v1${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${playerInfo.accessToken}`
          }
        })
      }

      if (data.error.status == 400) 
        return resolve({ loadType: 'empty', data: {} })
    
      if (data.error)
        return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'UNKNOWN', cause: 'unknown' } })
    }

    switch (type[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.name} ${data.artists[0].name}"`)

        if (search.loadType == 'error')
          return resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.artists[0].name,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.album.images[0].url,
          isrc: null,
          sourceName: 'spotify'
        }

        resolve({
          loadType: 'track',
          data: {
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          }
        })

        break
      }
      case 'episode': {
        const search = await searchWithDefault(`"${data.name} ${data.publisher}"`)

        if (search.loadType == 'error')
          return resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.publisher,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.images[0].url,
          isrc: null,
          sourceName: 'spotify'
        }

        resolve({
          loadType: 'track',
          data: {
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          }
        })

        break
      }
      case 'playlist':
      case 'album': {
        const tracks = []

        data.tracks.items.forEach(async (track, index) => {
          let search
          if (type[1] == 'playlist') search = await searchWithDefault(`"${track.track.name} ${track.track.artists[0].name}"`)
          else search = await searchWithDefault(`"${track.name} ${track.artists[0].name}"`)

          if (search.loadType == 'error')
            return resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: type[1] == 'playlist' ? track.track.artists[0].name : track.artists[0].name,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: type[1] == 'playlist' ? track.track.name : track.name,
            uri: type[1] == 'playlist' ? track.track.external_urls.spotify : track.external_urls.spotify,
            artworkUrl: type[1] == 'playlist' ? data.images[0].url : data.images[0].url,
            isrc: null,
            sourceName: 'spotify'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          })

          if (index == data.tracks.items.length - 1) {
            resolve({
              loadType: 'playlist',
              data: {
                info: {
                  name: data.name,
                  selectedTrack: 0
                },
                pluginInfo: {},
                tracks
              }
            })
          }
        })

        break
      }
      case 'show': {
        const tracks = []

        data.episodes.items.forEach(async (episode, index) => {
          const search = await searchWithDefault(`"${episode.name} ${episode.publisher}"`)

          if (search.loadType == 'error')
            return resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: episode.publisher,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: episode.name,
            uri: episode.external_urls.spotify,
            artworkUrl: episode.images[0].url,
            isrc: null,
            sourceName: 'spotify'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          })

          if (index == data.episodes.items.length - 1) {
            resolve({
              loadType: 'playlist',
              data: {
                info: {
                  name: data.name,
                  selectedTrack: 0
                },
                pluginInfo: {},
                tracks
              }
            })
          }
        })

        break
      }
    }
  })
}

export default {
  setSpotifyToken,
  search,
  loadFrom
}