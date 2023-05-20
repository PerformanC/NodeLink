import fs from 'node:fs'

import utils from '../utils.js'

async function loadFrom(path) {
  return new Promise(async (resolve) => {
    utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'local', query: path })

    fs.open(path, (err) => {
      if (err)
        return resolve({ loadType: 'error', exception: { message: 'File not found', severity: 'common', cause: 'unknown' } })
    
      const track = {
        identifier: 'unknown',
        isSeekable: false,
        author: 'unknown',
        length: -1,
        isStream: false,
        position: 0,
        title: 'unknown',
        uri: path,
        artworkUrl: null,
        isrc: null,
        sourceName: 'local'
      }

      utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'local', track, query: path })

      resolve({
        loadType: 'track',
        data: {
          encoded: utils.encodeTrack(track),
          info: track,
          pluginInfo: {}
        }
      })
    })
  })
}

export default loadFrom