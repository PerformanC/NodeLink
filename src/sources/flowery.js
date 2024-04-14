import { URL } from 'node:url'

import config from '../../config.js'

import { debugLog, encodeTrack } from '../utils.js'

async function loadFrom(text) {
  debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'flowery', query: text })

  const track = {
    identifier: 'unknown',
    isSeekable: false,
    author: 'unknown',
    length: -1,
    isStream: false,
    position: 0,
    title: text.substring(0, 2000),
    uri: 'unknown',
    artworkUrl: null,
    isrc: null,
    sourceName: 'flowery'
  }

  debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'flowery', track, query: text })

  return {
    loadType: 'track',
    data: {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }
}

function retrieveStream(title) {
  const floweryConfig = config.search.sources.flowery.config
  let audioFormat = null
  switch (config.audio.quality) {
    case 'high': audioFormat = 'wav'; break
    case 'medium': audioFormat = 'flac'; break
    case 'low': audioFormat = 'ogg_opus'; break
    case 'lowest': audioFormat = 'mp3'; break
    default: audioFormat = 'wav'; break
  }

  if (config.search.sources.flowery.enforceConfig) {
    return `https://api.flowery.pw/v1/tts?voice=${floweryConfig.voice}&text=${encodeURIComponent(title)}&translate=${floweryConfig.translate}&silence=${floweryConfig.silence}&audio_format=${audioFormat}&speed=${floweryConfig.speed}`
  } else {
    const titleInfo = new URL(title, 'https://example.com')

    return `https://api.flowery.pw/v1/tts?voice=${titleInfo.searchParams.get('voice') || floweryConfig.voice}&text=${titleInfo.pathname.substring(1)}&translate=${titleInfo.searchParams.get('translate') || floweryConfig.translate}&silence=${titleInfo.searchParams.get('silence') || floweryConfig.silence}&audio_format=${audioFormat}&speed=${titleInfo.searchParams.get('speed') || floweryConfig.speed}`
  }  
}

export default {
  loadFrom,
  retrieveStream
}