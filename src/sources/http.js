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
    loadType: 'track',
    data: {
      encoded: utils.nodelink_encodeTrack(infoObj),
      info: infoObj,
      pluginInfo: {}
    }
  }
}

export default loadFrom