import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import https from 'https'
import { Transform } from 'node:stream'

import config from '../../config.js'
import utils from '../utils.js'

let playerInfo = {
  licenseToken: null,
  csrfToken: null,
  mediaUrl: null,
  Cookie: null
}

const bufferSize = 2048
const IV = Buffer.from(Array.from({length: 8}, (_i, x) => x))

function initDeezer() {
  utils.debugLog('deezer', 5, { type: 1, message: 'Fetching user data...' })

  utils.makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=${config.search.sources.deezer.apiToken}`, {
    method: 'GET',
    getCookies: true
  }).then((res) => {
    playerInfo.Cookie = res.cookies.join('; ')

    playerInfo.licenseToken = res.body.results.USER.OPTIONS.license_token
    playerInfo.csrfToken = res.body.results.checkForm
    playerInfo.mediaUrl = res.body.results.URL_MEDIA

    utils.debugLog('deezer', 5, { type: 1, message: 'Successfully fetched user data.' })
  })
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

    utils.debugLog('loadtracks', 4, { type: 1, loadType: type[1], sourceName: 'Deezer', query })

    const data = await utils.makeRequest(`https://api.deezer.com/2.0/${endpoint}`, { method: 'GET' })

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
            encoded: utils.encodeTrack(track),
            info: track,
            pluginInfo: {}
          })
        })

        utils.debugLog('loadtracks', 4, { type: 2, loadType: type[1], sourceName: 'Deezer', playlistName: data.title })

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
    if (shouldLog) utils.debugLog('search', 4, { type: 1, sourceName: 'Deezer', query })

    const data = await utils.makeRequest(`https://api.deezer.com/2.0/search?q=${encodeURI(query)}`, { method: 'GET' })

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
        encoded: utils.encodeTrack(track),
        info: track,
        pluginInfo: {}
      })
    })

    if (tracks.length == 0) resolve({ loadType: 'empty', data: {} })

    if (shouldLog) utils.debugLog('search', 4, { type: 2, sourceName: 'deezer', tracksLen: tracks.length, query })

    resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

function retrieveStream(identifier, title) {
  return new Promise(async (resolve) => {
    const data = await utils.makeRequest(`https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${playerInfo.csrfToken}`, {
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

      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'Deezer', query: title, message: errorMessage })

      return resolve({ exception: { message: errorMessage, severity: 'fault', cause: 'Unknown' } })
    }

    const trackInfo = data.results.data[0]

    const streamData = await utils.makeRequest('https://media.deezer.com/v1/get_url', {
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

    return resolve({ url: streamData.data[0].media[0].sources[0].url, protocol: 'https', additionalData: trackInfo })
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

class DecryptStream extends Transform {
  constructor(songId, options) {
    options = options || {}
    options.objectMode = true
    super(options)
    this._buf = Buffer.alloc(0)
    this._totalChunkCount = 0

    const key = config.search.sources.deezer.decryptionKey
    const songIdHash = crypto.createHash('md5').update(songId, 'ascii').digest('hex')
    this._trackKey = Buffer.alloc(16)

    for (let i = 0; i < 16; i++) {
      this._trackKey.writeInt8(songIdHash[i].charCodeAt(0) ^ songIdHash[i + 16].charCodeAt(0) ^ key[i].charCodeAt(0), i);
    }
  }

  _createDecipher() {
    return crypto.createDecipheriv('bf-cbc', this._trackKey, IV).setAutoPadding(false);
  }

  _transform(data, _encoding, callback) {
    this._buf = Buffer.concat([this._buf, data])

    while (this._buf.length >= bufferSize) {
      this._processChunk(this._buf.subarray(0, bufferSize))
      this._buf = this._buf.subarray(bufferSize)
    }

    callback()
  }

  _processChunk(chunk) {
    if (this._totalChunkCount % 3 === 0) {
      const f = this._createDecipher()
      this.push(f.update(chunk))
      this.push(f.final())
    } else this.push(chunk)

    this._totalChunkCount++
  }

  _flush(callback) {
    if (this._buf) this.push(this._buf)

    callback()
  }
}

function loadTrack(url, trackInfos) {
  const stream = new DecryptStream(trackInfos.SNG_ID)// new PassThrough()

  // const trackKey = _calculateKey(trackInfos.SNG_ID)
  // let buf = Buffer.alloc(0)
  // let i = 0

  // utils.http1makeRequest(url, { method: 'GET', streamOnly: true }).then((res) => {
  https.get(url, (res) => {
    res.pipe(stream)
    // res.on('readable', () => {
    //   let chunk = null
    //   while (1) {
    //     // if (res.destroyed || !res.readableLength) break
    //     // if (res.readableLength <= bufferSize)  {
    //     //   chunk = res.read(res.readableLength)
          
    //     //   stream.push(chunk)
    //     //   break
    //     // }

    //     chunk = res.read(bufferSize)

    //     if (!chunk) {
    //       console.log('ok..?')
    //       if (res.readableLength) {
    //         chunk = res.read(res.readableLength)
    //         stream.push(chunk)
    //       }

    //       break
    //     }
          
    //     // }

    //     buf = Buffer.concat([buf, chunk])

    //     while (buf.length >= bufferSize) {
    //       if (i % 3 == 0) {
    //         const decipher = crypto.createDecipheriv('bf-cbc', trackKey, IV).setAutoPadding(false);
    
    //         stream.push(decipher.update(buf.subarray(0, bufferSize)))
    //         stream.push(decipher.final())
    //       } else {
    //         stream.push(chunk)
    //       }
      
    //       i++
      
    //       buf = buf.subarray(bufferSize)
    //     }
    //   }
    // })

    // res.on('end', () => stream.end())
  })

  return stream
}

export default {
  initDeezer,
  loadFrom,
  search,
  retrieveStream,
  loadTrack
}