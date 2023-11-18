import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack } from '../utils.js'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    if (!/https?:\/\/[\w-]+\.bandcamp\.com\/(track|album)\/[\w-]+/.test(url))
      return resolve({ loadType: 'empty', data: {} })

    const data = await makeRequest(url, { method: 'GET' })
    const matches = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(data)

    if (!matches.length)
      return resolve({ loadType: 'empty', data: {} })

    const trackInfo = JSON.parse(matches[1])

    debugLog('loadtracks', 4, { type: 1, loadType: trackInfo['@type'] == 'MusicRecording' ? 'track' : 'album', sourceName: 'BandCamp', query: url })

    switch (trackInfo['@type']) {
      case 'MusicRecording': {
        const identifier = trackInfo['@id'].match(/^https?:\/\/([^/]+)\/track\/([^/?]+)/)
    
        const track = {
          identifier: `${identifier[1]}:${identifier[2]}`,
          isSeekable: true,
          author: trackInfo.byArtist.name,
          length: (trackInfo.duration.split('P')[1].split('H')[0] * 3600000) + (trackInfo.duration.split('H')[1].split('M')[0] * 60000) + (trackInfo.duration.split('M')[1].split('S')[0] * 1000),
          isStream: false,
          position: 0,
          title: trackInfo.name,
          uri: trackInfo['@id'],
          artworkUrl: trackInfo.image,
          isrc: null,
          sourceName: 'bandcamp'
        }
    
        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'BandCamp', track, query: url })
    
        resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })

        break
      }
      case 'MusicAlbum': {
        const tracks = []

        trackInfo.track.itemListElement.forEach((item, i) => {
          const identifier = item.item['@id'].match(/^https?:\/\/([^/]+)\/track\/([^/?]+)/)

          const track = {
            identifier: `${identifier[1]}:${identifier[2]}`,
            isSeekable: true,
            author: trackInfo.byArtist.name,
            length: (item.item.duration.split('P')[1].split('H')[0] * 3600000) + (item.item.duration.split('H')[1].split('M')[0] * 60000) + (item.item.duration.split('M')[1].split('S')[0] * 1000),
            isStream: false,
            position: i,
            title: item.item.name,
            uri: item.item['@id'],
            artworkUrl: trackInfo.image,
            isrc: null,
            sourceName: 'bandcamp'
          }

          tracks.push({
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          })
        })

        debugLog('loadtracks', 4, { type: 2, loadType: 'album', sourceName: 'BandCamp', playlistName: trackInfo.name })

        resolve({
          loadType: 'album',
          data: {
            info: {
              name: trackInfo.name,
              selectedTrack: 0
            },
            tracks
          }
        })

        break
      }
    }
  })
}

async function search(query, shouldLog) {
  return new Promise(async (resolve) => {
    if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'BandCamp', query })

    const data = await makeRequest(`https://bandcamp.com/search?q=${encodeURI(query)}&item_type=t&from=results`, { method: 'GET' })

    const names = data.match(/<div class="heading">\s+<a.*?>(.*?)<\/a>/gs)

    if (!names)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    
    names.forEach((name, i) => {
      if (i >= config.options.maxResultsLength) return;

      tracks.push({
        encoded: null,
        info: {
          identifier: null,
          isSeekable: true,
          author: null,
          length: -1,
          isStream: false,
          position: i++,
          title: name[1].trim(),
          uri: null,
          artworkUrl: null,
          isrc: null,
          sourceName: 'bandcamp'
        }
      })
    })

    if (!tracks.length)
      return resolve({ loadType: 'empty', data: {} })

    const authors = data.match(/<div class="subhead">\s+(?:from\s+)?[\s\S]*?by (.*?)\s+<\/div>/gs)

    authors.forEach((author, i) => {
      if (i >= config.options.maxResultsLength) return;

      tracks[i].info.author = author.split('by')[1].split('</div>')[0].trim()
    })

    const artworkUrls = data.match(/<div class="art">\s*<img src="(.+?)"/gs)

    artworkUrls.forEach((artworkUrl, i) => {
      if (i >= config.options.maxResultsLength) return;

      tracks[i].info.artworkUrl = artworkUrl.split('"')[3].split('"')[0]
    })

    const urls = data.match(/<div class="itemurl">\s+<a.*?>(.*?)<\/a>/gs)

    urls.forEach((url, i) => {
      if (i >= config.options.maxResultsLength) return;

      tracks[i].info.uri = url.split('">')[2].split('</a>')[0]
      
      const identifier = tracks[i].info.uri.match(/^https?:\/\/([^/]+)\/track\/([^/?]+)/)
      tracks[i].info.identifier = `${identifier[1]}:${identifier[2]}`

      tracks[i].encoded = encodeTrack(tracks[i].info)
      tracks[i].pluginInfo = {}
    })

    if (shouldLog) debugLog('search', 4, { type: 2, sourceName: 'BandCamp', tracksLen: tracks.length, query })

    resolve({
      loadType: 'search',
      data: tracks
    })
  })
}

async function retrieveStream(uri, title) {
  return new Promise(async (resolve) => {
    const data = await makeRequest(uri, { method: 'GET' })

    const streamURL = data.match(/https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/)

    if (!streamURL) {
      debugLog('retrieveStream', 4, { type: 2, sourceName: 'BandCamp', query: title, message: 'No stream URL was found.' })

      return resolve({ exception: { message: 'Failed to get the stream from source.', severity: 'fault', cause: 'Unknown' } })
    }

    resolve({ url: streamURL[0], protocol: 'https', format: 'arbitrary' })
  })
}

export default {
  loadFrom,
  search,
  retrieveStream
}