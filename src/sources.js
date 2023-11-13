import { PassThrough } from 'node:stream'

import config from '../config.js'
import bandcamp from './sources/bandcamp.js'
import deezer from './sources/deezer.js'
import httpSource from './sources/http.js'
import local from './sources/local.js'
import pandora from './sources/pandora.js'
import soundcloud from './sources/soundcloud.js'
import spotify from './sources/spotify.js'
import youtube from './sources/youtube.js'

import { debugLog, http1makeRequest, makeRequest } from './utils.js'

async function getTrackURL(track) {
  return new Promise(async (resolve) => {
    switch ([ 'pandora', 'spotify' ].includes(track.sourceName) ? config.search.defaultSearchSource : track.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        resolve(youtube.retrieveStream(track.identifier, track.sourceName, track.title))
  
        break
      }
      case 'local': {
        resolve({ url: track.uri, protocol: 'file' })

        break
      }

      case 'http':
      case 'https': {
        resolve({ url: track.uri, protocol: track.sourceName })
        
        break
      }
      case 'soundcloud': {
        resolve(soundcloud.retrieveStream(track.identifier, track.title))

        break
      }
      case 'bandcamp': {
        resolve(bandcamp.retrieveStream(track.uri, track.title))

        break
      }
      case 'deezer': {
        resolve(deezer.retrieveStream(track.identifier, track.title))

        break
      }
      default: {
        resolve({ exception: { message: 'Unknown source', severity: 'common', cause: 'Not supported source.' } })

        break
      }
    }
  })
}

function getTrackStream(decodedTrack, url, protocol, additionalData) {
  return new Promise(async (resolve) => {
    if (protocol == 'file') {
      const file = fs.createReadStream(url)

      file.on('error', () => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Failed to retrieve stream from source. (File not found or not accessible)' })

        resolve({ status: 1, exception: { message: 'Failed to retrieve stream from source. (File not found or not accessible)', severity: 'common', cause: 'No permission to access file or doesn\'t exist' } })
      })

      resolve({ stream: file, type: 'arbitrary' })
    } else {
      const trueSource = [ 'pandora', 'spotify' ].includes(decodedTrack.sourceName) ? config.search.defaultSearchSource : decodedTrack.sourceName

      if (trueSource == 'deezer')
        return resolve({ stream: await deezer.loadTrack(title, url, additionalData), type: 'arbitrary' })

      if (trueSource == 'soundcloud') {
        const stream = await soundcloud.loadStream(title, url, protocol)

        return resolve({ stream: stream, type: 'arbitrary' })
      }

      const res = await ((trueSource == 'youtube' || trueSource == 'ytmusic') ? http1makeRequest : makeRequest)(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Range': 'bytes=0-'
        },
        method: 'GET',
        streamOnly: true
      }).catch((error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: error.message })

        resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
      })

      if (res.statusCode != 200 && res.statusCode != 206 && res.statusCode != 302) {
        res.destroy()

        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: `Failed to retrieve stream from source. (${res.statusCode} != 200, 206 or 302)` })

        return resolve({ status: 1, exception: { message: `Failed to retrieve stream from source. (${res.statusCode} != 200, 206 or 302)`, severity: 'suspicious', cause: 'Wrong status code' } })
      }

      const stream = new PassThrough()

      res.on('data', (chunk) => stream.write(chunk))
      res.on('end', () => stream.end())
      res.on('error', (error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: error.message })

        resolve({ status: 1, exception: { message: error.message, severity: 'fault', cause: 'Unknown' } })
      })

      res.once('readable', () => {
        resolve({ stream, type: [ 'youtube', 'ytmusic' ].includes(trueSource) ? 'webm/opus' : 'arbitrary' })
      })
    }
  })
}

export default {
  getTrackURL,
  getTrackStream,
  bandcamp,
  deezer,
  http: httpSource,
  local,
  pandora,
  soundcloud,
  spotify,
  youtube,
}