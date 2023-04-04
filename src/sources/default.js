import config from '../../config.js'
import youtube from './youtube.js'
import soundcloud from './soundcloud.js'
import bandcamp from './bandcamp.js'

async function searchWithDefault(query) {
  switch (config.search.defaultSearchSource) {
    case 'youtube': {
      console.log('[NodeLink]: Default search source: YouTube, searching...')
      return youtube.search(query, 1)
    }
    case 'soundcloud': {
      console.log('[NodeLink]: Default search source: SoundCloud, searching...')
      return soundcloud.search(query)
    }
    case 'bandcamp': {
      console.log('[NodeLink]: Default search source: Bandcamp, searching...')
      return bandcamp.search(query)
    }
    default: {
      console.log('[NodeLink]: Default search source: unknown, falling back to YouTube...')
      return youtube.search(query, 1)
    }
  }
}

export default searchWithDefault