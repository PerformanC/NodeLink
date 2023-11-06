import utils from '../utils.js'

async function loadFrom(uri) {
  const type = uri.startsWith('http://') ? 'http' : 'https'
  utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: type, query: uri })

  try {
    const data = await utils.http1makeRequest(uri, { method: 'GET', retrieveHeaders: true })

    if (!data['content-type'].startsWith('audio/')) {
      return {
        loadType: 'error',
        data: {
          message: 'Url is not a playable stream.',
          severity: 'common',
          cause: 'Invalid URL'
        }
      }
    }

    const track = {
      identifier: 'unknown',
      isSeekable: false,
      author: 'unknown',
      length: -1,
      isStream: false,
      position: 0,
      title: 'unknown',
      uri,
      artworkUrl: null,
      isrc: null,
      sourceName: type
    }

    utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: type, track, query: uri })

    return {
      loadType: 'track',
      data: {
        encoded: utils.encodeTrack(track),
        info: track,
        pluginInfo: {}
       }
    }
  } catch {
    utils.debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: type, query: uri, message: 'Not possible to connect to url.', })

    return {
      loadType: 'error',
      data: {
        message: 'Not possible to connect to url.',
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }
}

export default {
  loadFrom
}