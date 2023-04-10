import config from '../config.js'
import utils from './utils.js'
import bandcamp from './sources/bandcamp.js'
import deezer from './sources/deezer.js'
import http from './sources/http.js'
import local from './sources/local.js'
import pandora from './sources/pandora.js'
import soundcloud from './sources/soundcloud.js'
import spotify from './sources/spotify.js'
import youtube from './sources/youtube.js'

import fs from 'fs'

async function getTrackURL(track) {
  return new Promise(async (resolve) => {
    switch ([ 'deezer', 'spotify', 'pandora' ].includes(track.sourceName) ? config.search.defaultSearchSource : track.sourceName) {
      case 'local':
      case 'http': {
        resolve({ status: 0, url: track.uri })
        
        break
      }
      case 'soundcloud': {
        fs.readFile(`./cache/${track.sourceName}.json`, async (err, data) => {
          if (err) {
            console.log(`[NodeLink:sources]: Error reading ${track.sourceName} cache file: ${err}`)

            return
          }

          const cache = JSON.parse(data)

          if (cache[track.identifier]) {
            console.log(`[NodeLink:sources]: Track found cached: ${track.identifier}`)

            return resolve({ status: 0, url: cache[track.identifier] })
          }

          console.log(`[NodeLink:sources]: Track was not cached: ${track.identifier}`)

          const url = await soundcloud.retrieveStream(track.identifier)

          if (url.status == 0) cache[track.identifier] = url.url
          else return resolve(url)
          
          utils.safelyWriteFile(`./cache/${track.sourceName}.json`, JSON.stringify(cache))

          resolve(url)
        })

        break
      }
      case 'bandcamp': {
        fs.readFile(`./cache/${track.sourceName}.json`, async (err, data) => {
          if (err) {
            console.log(`[NodeLink:sources]: Error reading ${track.sourceName} cache file: ${err}`)
            
            return
          }

          const cache = JSON.parse(data)

          if (cache[track.identifier]) {
            console.log(`[NodeLink:sources]: Track found cached: ${track.identifier}`)

            return resolve({ status: 0, url: cache[track.identifier] })
          }

          console.log(`[NodeLink:sources]: Track was not cached: ${track.identifier}`)

          const url = await bandcamp.retrieveStream(track.identifier)

          if (url.status == 0) cache[track.identifier] = url.url
          else return resolve(url)
          
          utils.safelyWriteFile(`./cache/${track.sourceName}.json`, JSON.stringify(cache))

          resolve(url)
        })

        break
      }
      case 'ytmusic':
      case 'youtube': {
        fs.readFile(`./cache/${track.sourceName}.json`, async (err, data) => {
          if (err) {
            console.log(`[NodeLink:sources]: Error reading ${track.sourceName} cache file: ${err}`)
            return
          }

          const cache = JSON.parse(data)

          if (cache[track.identifier]) {
            console.log(`[NodeLink:sources]: Track found cached: ${track.identifier}`)

            return resolve({ status: 0, url: cache[track.identifier] })
          }

          console.log(`[NodeLink:sources]: Track was not cached: ${track.identifier}`)

          const url = await youtube.retrieveStream(track.identifier, track.sourceName)

          if (url.status == 0) cache[track.identifier] = url.url
          else return resolve(url)
          
          utils.safelyWriteFile(`./cache/${track.sourceName}.json`, JSON.stringify(cache))

          resolve(url)
        })
  
        break
      }
      default: {
        resolve({ status: 1, exception: { severity: 'COMMON', message: 'Unknown source' } })

        break
      }
    }
  })
}

export default {
  getTrackURL,
  bandcamp: {
    loadFrom: bandcamp.loadFrom,
    search: bandcamp.search
  },
  deezer: {
    loadFrom: deezer
  },
  http: {
    loadFrom: http
  },
  local: {
    loadFrom: local
  },
  pandora: {
    loadFrom: pandora.loadFrom,
    search: pandora.search,
    setToken: pandora.setToken
  },
  soundcloud: {
    loadFrom: soundcloud.loadFrom,
    search: soundcloud.search
  },
  spotify: {
    loadFrom: spotify.loadFrom,
    search: spotify.search,
    setSpotifyToken: spotify.setSpotifyToken
  },
  youtube: {
    search: youtube.search,
    startInnertube: youtube.startInnertube,
    stopInnertube: youtube.stopInnertube
  }
}