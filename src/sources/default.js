import config from '../../config.js'
import youtube from './youtube.js'
import soundcloud from './soundcloud.js'
import bandcamp from './bandcamp.js'

async function searchWithDefault(query) {
  switch (config.search.defaultSearchSource) {
    case 'ytmusic':
    case 'youtube': {
      return youtube.search(query, config.search.defaultSearchSource)
    }
    case 'soundcloud': {
      return soundcloud.search(query)
    }
    case 'bandcamp': {
      return bandcamp.search(query)
    }
    default: {
      console.warn('[NodeLink:sources]: Default search source: unknown, falling back to YouTube...')
      return youtube.search(query, 1)
    }
  }
}

export default searchWithDefault