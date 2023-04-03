async function loadFrom(uri) {
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
    loadType: 'TRACK_LOADED',
    playlistInfo: null,
    tracks: [{
      encoded: utils.nodelink_encodeTrack(infoObj),
      info: infoObj
    }],
    exception: null
  }
}

export default loadFrom