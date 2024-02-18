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
import genius from './sources/genius.js'
import musixmatch from './sources/musixmatch.js'

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
        resolve({ url: track.uri, protocol: 'file', format: 'arbitrary' })

        break
      }

      case 'http':
      case 'https': {
        resolve({ url: track.uri, protocol: track.sourceName, format: 'arbitrary' })
        
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
    if (protocol === 'file') {
      const file = fs.createReadStream(url)

      file.on('error', () => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Failed to retrieve stream from source. (File not found or not accessible)' })

        resolve({ status: 1, exception: { message: 'Failed to retrieve stream from source. (File not found or not accessible)', severity: 'common', cause: 'No permission to access file or doesn\'t exist' } })
      })

      resolve({ stream: file, type: 'arbitrary' })
    } else {
      let trueSource = [ 'pandora', 'spotify' ].includes(decodedTrack.sourceName) ? config.search.defaultSearchSource : decodedTrack.sourceName

      if (trueSource === 'deezer')
        return resolve({ stream: await deezer.loadTrack(decodedTrack.title, url, additionalData) })

      if (trueSource === 'soundcloud') {
        if (additionalData !== true) {
          const stream = await soundcloud.loadStream(decodedTrack.title, url, protocol)

          return resolve({ stream })
        } else {
          trueSource = config.search.fallbackSearchSource
        }
      }

      const res = await ((trueSource === 'youtube' || trueSource === 'ytmusic') ? http1makeRequest : makeRequest)(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
        },
        method: 'GET',
        streamOnly: true
      })

      if (res.statusCode !== 200) {
        res.stream.emit('end') /* (http1)makeRequest will handle this automatically */

        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: `Expected 200, received ${res.statusCode}.` })

        return resolve({
          status: 1,
          exception: {
            message: `Failed to retrieve stream from source. Expected 200, received ${res.statusCode}.`,
            severity: 'suspicious',
            cause: 'Wrong status code'
          }
        })
      }

      const stream = new PassThrough()

      res.stream.on('data', (chunk) => stream.write(chunk))
      res.stream.on('end', () => stream.end())
      res.stream.on('error', (error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: error.message })

        resolve({
          status: 1,
          exception: {
            message: error.message,
            severity: 'fault',
            cause: 'Unknown'
          }
        })
      })

      resolve({ stream })
    }
  })
}

function loadLyrics(decodedTrack, language, generic) {
  return new Promise(async (resolve) => {
    let captions = { loadType: 'empty', data: {} }

    switch (generic ? config.search.defaultSearchSource : decodedTrack.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        if (!config.search.sources[decodedTrack.sourceName]) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await sources.youtube.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      case 'spotify': {
        if (!config.search.sources[config.search.defaultSearchSource] || !config.search.sources.spotify.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        if (config.search.sources.spotify.sp_dc === 'DISABLED')
          return resolve(loadLyrics(decodedTrack, language, true))

        captions = await sources.spotify.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      case 'deezer': {
        if (!config.search.sources.deezer.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        if (config.search.sources.deezer.arl === 'DISABLED')
          return resolve(loadLyrics(decodedTrack, language, true))

        captions = await sources.deezer.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      default: {
        if (!config.search.sources[config.search.lyricsFallbackSearchSource]) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await sources[config.search.lyricsFallbackSearchSource].loadLyrics(decodedTrack, language) || captions

        break
      }
    }

    resolve(captions)
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
  genius,
  musixmatch
}
