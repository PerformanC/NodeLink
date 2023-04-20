import config from '../config.js'
import bandcamp from './sources/bandcamp.js'
import deezer from './sources/deezer.js'
import http from './sources/http.js'
import local from './sources/local.js'
import pandora from './sources/pandora.js'
import soundcloud from './sources/soundcloud.js'
import spotify from './sources/spotify.js'
import youtube from './sources/youtube.js'

async function getTrackURL(track) {
  return new Promise(async (resolve) => {
    switch ([ 'deezer', 'pandora', 'spotify' ].includes(track.sourceName) ? config.search.defaultSearchSource : track.sourceName) {
      case 'local':
      case 'http': {
        resolve({ url: track.uri })
        
        break
      }
      case 'soundcloud': {
        resolve(soundcloud.retrieveStream(track.identifier))

        break
      }
      case 'bandcamp': {
        resolve(bandcamp.retrieveStream(track.identifier))

        break
      }
      case 'ytmusic':
      case 'youtube': {
        resolve(youtube.retrieveStream(track.identifier, track.sourceName))
  
        break
      }
      default: {
        resolve({ exception: { severity: 'COMMON', message: 'Unknown source' } })

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
    loadFrom: youtube.loadFrom,
    startInnertube: youtube.startInnertube,
    stopInnertube: youtube.stopInnertube,
    getCaptions: youtube.getCaptions
  }
}