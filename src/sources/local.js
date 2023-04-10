import fs from 'fs'

import utils from '../utils.js'

async function loadFrom(path) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink:sources]: Loading track from local: ${path}`)

    fs.open(path, (err) => {
      if (err)
        return resolve({ loadType: 'error', exception: { message: 'File not found', severity: 'COMMON', cause: 'unknown' } })
    
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
        loadType: 'track',
        data: {
          encoded: utils.nodelink_encodeTrack(infoObj),
          info: infoObj,
          pluginInfo: {}
        }
      })
    })
  })
}

export default loadFrom