import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'

import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack } from '../utils.js'

let playerInfo = {
  licenseToken: null,
  csrfToken: null,
  mediaUrl: null,
  Cookie: null
}

const bufferSize = 2048
const IV = Buffer.from(Array.from({length: 8}, (_i, x) => x))

async function init() {
  if (playerInfo.licenseToken) return;
  // TODO: Need to reset when timestamp is expired

  debugLog('deezer', 5, { type: 1, message: 'Fetching user data...' })

  const res = await makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=${config.search.sources.deezer.apiToken}`, {
    method: 'GET',
    getCookies: true
  })

  playerInfo.Cookie = res.cookies.join('; ')

  playerInfo.licenseToken = res.body.results.USER.OPTIONS.license_token
  playerInfo.csrfToken = res.body.results.checkForm
  playerInfo.mediaUrl = res.body.results.URL_MEDIA

  debugLog('deezer', 5, { type: 1, message: 'Successfully fetched user data.' })
}

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

    debugLog('loadtracks', 4, { type: 1, loadType: type[1], sourceName: 'Deezer', query })

    const data = await makeRequest(`https://api.deezer.com/2.0/${endpoint}`, { method: 'GET' })

    if (data.error) {
      if (data.error.code == 800) 
        return resolve({ loadType: 'empty', data: {} })

      return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'fault', cause: 'Unknown' } })
    }

    switch (type[1]) {
      case 'track': {
        const track = {
          identifier: data.id.toString(),
          isSeekable: true,
          author: data.artist.name,
          length: data.duration * 1000,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.link,
          artworkUrl: data.album.cover_xl,
          isrc: data.isrc,
          sourceName: 'deezer'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Deezer', track, query })

        resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
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

        data.tracks.data.forEach(async (item, i) => {
          if (i >= config.options.maxAlbumPlaylistLength) return;

          const track = {
            identifier: item.id.toString(),
            isSeekable: true,
            author: item.artist.name,
            length: item.duration * 1000,
            isStream: false,
            position: index++,
            title: item.title,
            uri: item.link,
            artworkUrl: type[1] == 'album' ? data.cover_xl : data.picture_xl,
            isrc: null,
            sourceName: 'deezer'
          }

          tracks.push({
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          })
        })

        debugLog('loadtracks', 4, { type: 2, loadType: type[1], sourceName: 'Deezer', playlistName: data.title })

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

        break
      }
    }
  })
}

function search(query, shouldLog) {
  return new Promise(async (resolve) => {
    if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'Deezer', query })

    const data = await makeRequest(`https://api.deezer.com/2.0/search?q=${encodeURI(query)}`, { method: 'GET' })

    // This API doesn't give ISRC, must change to internal API

    if (data.error)
      return resolve({ loadType: 'error', data: { message: data.error.message, severity: 'fault', cause: 'Unknown' } })

    const tracks = []
    let index = 0

    data.data.forEach(async (item) => {
      if (index >= config.options.maxResultsLength || item.type != 'track') return;

      const track = {
        identifier: item.id.toString(),
        isSeekable: true,
        author: item.artist.name,
        length: item.duration * 1000,
        isStream: false,
        position: index++,
        title: item.title,
        uri: item.link,
        artworkUrl: item.album.cover_xl,
        isrc: item.isrc,
        sourceName: 'deezer'
      }

      tracks.push({
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {}
      })
    })

    if (tracks.length == 0) resolve({ loadType: 'empty', data: {} })

    if (shouldLog) debugLog('search', 4, { type: 2, sourceName: 'deezer', tracksLen: tracks.length, query })

    resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

function retrieveStream(identifier, title) {
  return new Promise(async (resolve) => {
    const data = await makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${playerInfo.csrfToken}`, {
      body: {
        sng_ids: [ identifier ]
      },
      headers: {
        Cookie: playerInfo.Cookie
      },
      method: 'POST',
      disableBodyCompression: true
    })

    if (data.error.length != 0) {
      const errorMessage = Object.keys(data.error).map((err) => data.error[err]).join('; ')

      debugLog('retrieveStream', 4, { type: 2, sourceName: 'Deezer', query: title, message: errorMessage })

      return resolve({ exception: { message: errorMessage, severity: 'fault', cause: 'Unknown' } })
    }

    const trackInfo = data.results.data[0]

    const streamData = await makeRequest('https://media.deezer.com/v1/get_url', {
      body: {
        license_token: playerInfo.licenseToken,
        media: [{
          type: 'FULL',
          formats: [{
            cipher: 'BF_CBC_STRIPE',
            format: 'FLAC'
          }, {
            cipher: 'BF_CBC_STRIPE',
            format: 'MP3_256'
          }, {
            cipher: 'BF_CBC_STRIPE',
            format: 'MP3_128'
          }, {
            cipher: 'BF_CBC_STRIPE',
            format: 'MP3_MISC'
          }]
        }],
        track_tokens: [ trackInfo.TRACK_TOKEN ]
      },
      method: 'POST',
      disableBodyCompression: true
    })

    return resolve({ url: streamData.data[0].media[0].sources[0].url, protocol: 'https', format: 'arbitrary', additionalData: trackInfo })
  })
}

function _calculateKey(songId) {
  const key = config.search.sources.deezer.decryptionKey
  const songIdHash = crypto.createHash('md5').update(songId, 'ascii').digest('hex')
  const trackKey = Buffer.alloc(16)

  for (let i = 0; i < 16; i++) {
    trackKey.writeInt8(songIdHash[i].charCodeAt(0) ^ songIdHash[i + 16].charCodeAt(0) ^ key[i].charCodeAt(0), i)
  }

  return trackKey
}

function loadTrack(title, url, trackInfos) {
  return new Promise(async (resolve) => {
    const stream = new PassThrough()

    const trackKey = _calculateKey(trackInfos.SNG_ID)
    let buf = Buffer.alloc(0)
    let i = 0

    const res = await makeRequest(url, {
      method: 'GET',
      streamOnly: true
    })

    res.on('end', () => stream.end())
    res.on('error', (error) => {
      debugLog('retrieveStream', 4, { type: 2, sourceName: 'Deezer', query: title, message: error.message })

      resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
    })

    res.on('readable', () => {
      let chunk = null
      while (1) {
        chunk = res.read(bufferSize)

        if (!chunk) {
          if (res.readableLength) {
            chunk = res.read(res.readableLength)
            stream.push(chunk)
          }

          break
        }

        buf = Buffer.concat([buf, chunk])

        while (buf.length >= bufferSize) {
          if (i % 3 == 0) {
            const decipher = crypto.createDecipheriv('bf-cbc', trackKey, IV).setAutoPadding(false);
    
            stream.push(decipher.update(buf.subarray(0, bufferSize)))
            stream.push(decipher.final())
          } else {
            stream.push(chunk)
          }
      
          i++
      
          buf = buf.subarray(bufferSize)
        }
      }

      resolve(stream)
    })
  })
}

export default {
  init,
  loadFrom,
  search,
  retrieveStream,
  loadTrack
}