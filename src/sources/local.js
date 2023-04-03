import fs from 'fs'

import utils from '../utils.js'

async function loadFrom(path) {
  return new Promise(async (resolve) => {
    fs.open(path, (err) => {
      if (err)
        return resolve({ loadType: 'LOAD_FAILED', exception: { severity: 'COMMON', message: 'File not found' } })
    
      const infoObj = {
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

      resolve({
        loadType: 'TRACK_LOADED',
        playlistInfo: null,
        tracks: [{
          encoded: utils.nodelink_encodeTrack(infoObj),
          info: infoObj
        }],
        exception: null
      })
    })
  })
}

export default loadFrom