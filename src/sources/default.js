import config from '../../config.js'
import youtube from './youtube.js'
import soundcloud from './soundcloud.js'
import bandcamp from './bandcamp.js'
import deezer from './deezer.js'

async function searchWithDefault(query, fallback) {
  switch (fallback ? config.search.fallbackSearchSource : config.search.defaultSearchSource) {
    case 'ytmusic':
    case 'youtube': {
      return youtube.search(query, config.search.defaultSearchSource, false)
    }
    case 'soundcloud': {
      return soundcloud.search(query, false)
    }
    case 'bandcamp': {
      return bandcamp.search(query, false)
    }
    case 'deezer': {
      return deezer.search(query, false)
    }
    default: {
      console.warn(`[\u001b[33msources\u001b[37m]: Default search source: unknown, falling back to: ${config.search.fallbackSearchSource}`)

      return searchWithDefault(query, true)
    }
  }
}

export default searchWithDefault