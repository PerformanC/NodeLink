import config from '../config.js'
import bandcamp from './sources/bandcamp.js'
import deezer from './sources/deezer.js'
import http from './sources/http.js'
import local from './sources/local.js'
import soundcloud from './sources/soundcloud.js'
import spotify from './sources/spotify.js'
import youtube from './sources/youtube.js'

async function getTrackURL(track) {
  return new Promise(async (resolve) => {
    if ([ 'deezer', 'spotify' ].includes(track.sourceName)) track.sourceName = config.search.defaultSearchSource

    switch (track.sourceName) {
      case 'local':
      case 'http': {
        resolve({ status: 0, url: track.uri })
        
        break
      }
      case 'soundcloud': {
        resolve(soundcloud.retrieveStream(track.identifier))

        break
      }
      case 'bandcamp': {
        resolve(bandcamp.retrieveStream(track.uri))

        break
      }
      case 'youtube': {
        resolve(youtube.retrieveStream(track.identifier))
  
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
    loadFrom: deezer,
  },
  http: {
    loadFrom: http,
  },
  local: {
    loadFrom: local,
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
    stopInnertube: youtube.stopInnertube,
    checkURLType: youtube.checkURLType
  }
}