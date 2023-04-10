import utils from '../utils.js'

async function loadFrom(uri) {
  console.log(`[NodeLink:sources]: Loading track from HTTP: ${uri}`)

  try {
    const data = await utils.nodelink_http1makeRequest(uri, { method: 'GET', retrieveHeaders: true })

    if (!data['content-type'].startsWith('audio/')) {
      return {
        loadType: 'error',
        data: {
          message: 'Url is not a playable stream.',
          severity: 'common',
          cause: 'Url error'
        }
      }
    }

    const infoObj = {
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
      sourceName: 'http'
   }

    return {
      loadType: 'track',
      data: {
        encoded: utils.nodelink_encodeTrack(infoObj),
        info: infoObj,
        pluginInfo: {}
       }
    }
  } catch {
    return {
      loadType: 'error',
      data: {
        message: 'Not possible to connect to url.',
        severity: 'common',
        cause: 'Url error'
      }
    }
  }
}

export default loadFrom