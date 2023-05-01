import config from '../../config.js'
import utils from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'BandCamp', query: url })

    const data = await utils.makeRequest(url, { method: 'GET' })

    const matches = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(data)

    if (!matches.length)
      return resolve({ loadType: 'empty', data: {} })

    const information = JSON.parse(matches[1])
    const identifier = url.match(/^https?:\/\/([^.]+)\.bandcamp\.com\/track\/([^/?]+)/)

    const track = {
      identifier: `${identifier[1]}:${identifier[2]}`,
      isSeekable: true,
      author: information.byArtist.name,
      length: (information.duration.split('P')[1].split('H')[0] * 3600000) + (information.duration.split('H')[1].split('M')[0] * 60000) + (information.duration.split('M')[1].split('S')[0] * 1000),
      isStream: false,
      position: 0,
      title: information.name,
      uri: url,
      artworkUrl: information.image,
      isrc: null,
      sourceName: 'bandcamp'
    }

    utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'BandCamp', track, query })

    resolve({
      loadType: 'track',
      data: {
        encoded: utils.encodeTrack(track),
        info: track,
        pluginInfo: {}
      }
    })
  })
}

async function search(query) {
  return new Promise(async (resolve) => {
    utils.debugLog('search', 4, { type: 1, sourceName: 'BandCamp', query })

    const data = await utils.makeRequest(`https://bandcamp.com/search?q=${encodeURI(query)}&item_type=t&from=results`, { method: 'GET' })

    const regex = /<div class="heading">\s+<a.*?>(.*?)<\/a>/gs
    const names = data.matchAll(regex)

    const tracks = []
    let i = 0
    
    for (const match of names) {
      if (i >= config.options.maxResults) break

      tracks.push({
        encoded: null,
        info: {
          identifier: null,
          isSeekable: true,
          author: null,
          length: -1,
          isStream: false,
          position: i++,
          title: match[1].trim(),
          uri: null,
          artworkUrl: null,
          isrc: null,
          sourceName: 'bandcamp'
        }
      })
    }

    if (!tracks.length)
      return resolve({ loadType: 'empty', data: {} })

    const authors = data.match(/<div class="subhead">\s+by\s+(.*?)\s+<\/div>/gs)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.author = authors[i].split('by')[1].split('</div>')[0].trim()
    }

    const artworkUrls = data.match(/<div class="art">\s*<img src="(.+?)"/g)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.artworkUrl = artworkUrls[i].split('"')[3].split('"')[0]
    }

    const urls = data.match(/<div class="itemurl">\s+<a.*?>(.*?)<\/a>/gs)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.uri = urls[i].split('"')[3].split('?from=')[0]
      
      const identifier = tracks[i].info.uri.match(/^https?:\/\/([^.]+)\.bandcamp\.com\/track\/([^/?]+)/)
      tracks[i].info.identifier = `${identifier[1]}:${identifier[2]}`

      tracks[i].encoded = utils.encodeTrack(tracks[i].info)
      tracks[i].pluginInfo = {}
    }

    utils.debugLog('search', 4, { type: 2, sourceName: 'BandCamp', tracksLen: tracks.length, query })

    resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

async function retrieveStream(uri) {
  return new Promise(async (resolve) => {
    const data = await utils.makeRequest(uri, { method: 'GET' })

    const streamURL = data.match(/https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/)

    if (!streamURL) {
      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'BandCamp', message: 'No stream URL was found.' })

      return resolve({ exception: { message: 'Failed to get the stream from source.', severity: 'suspicious', cause: 'unknown' } })
    }

    resolve({ url: streamURL[0], protocol: 'https' })
  })
}

export default {
  loadFrom,
  search,
  retrieveStream
}