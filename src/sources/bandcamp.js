import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack } from '../utils.js'

async function loadFrom(url) {
  const { body: data } = await makeRequest(url, { method: 'GET' })
  const matches = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(data)

  if (!matches.length) {
    debugLog('loadtracks', 4, { type: 2, loadType: 'empty', sourceName: 'BandCamp', query: url, message: 'No matches found.' })

    return {
      loadType: 'empty',
      data: {}
    }
  }

  const trackInfo = JSON.parse(matches[1])

  debugLog('loadtracks', 4, { type: 1, loadType: trackInfo['@type'] === 'MusicRecording' ? 'track' : 'album', sourceName: 'BandCamp', query: url })

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
  
      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(track),
          info: track,
          pluginInfo: {}
        }
      }
    }
    case 'MusicAlbum': {
      const tracks = []

      trackInfo.track.itemListElement.forEach((item) => {
        const identifier = item.item['@id'].match(/^https?:\/\/([^/]+)\/track\/([^/?]+)/)

        const track = {
          identifier: `${identifier[1]}:${identifier[2]}`,
          isSeekable: true,
          author: trackInfo.byArtist.name,
          length: (item.item.duration.split('P')[1].split('H')[0] * 3600000) + (item.item.duration.split('H')[1].split('M')[0] * 60000) + (item.item.duration.split('M')[1].split('S')[0] * 1000),
          isStream: false,
          position: 0,
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

      return {
        loadType: 'album',
        data: {
          info: {
            name: trackInfo.name,
            selectedTrack: 0
          },
          tracks
        }
      }
    }
  }
}

async function search(query, shouldLog) {
  if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'BandCamp', query })

  const { body: data } = await makeRequest(`https://bandcamp.com/search?q=${encodeURI(query)}&item_type=t&from=results`, { method: 'GET' })

  let names = data.match(/<div class="heading">\s+<a.*?>(.*?)<\/a>/gs)

  if (!names) {
    if (shouldLog) debugLog('search', 4, { type: 3, sourceName: 'BandCamp', query, message: 'No matches found.' })

    return {
      loadType: 'empty',
      data: {}
    }
  }

  const tracks = []

  if (names.length > config.options.maxSearchResults)
    names = names.slice(0, config.options.maxSearchResults)
  
  names.forEach((name) => {
    tracks.push({
      encoded: null,
      info: {
        identifier: null,
        isSeekable: true,
        author: null,
        length: -1,
        isStream: false,
        position: 0,
        title: name[1].trim(),
        uri: null,
        artworkUrl: null,
        isrc: null,
        sourceName: 'bandcamp'
      },
      pluginInfo: {}
    })
  })

  const authors = data.match(/<div class="subhead">\s+(?:from\s+)?[\s\S]*?by (.*?)\s+<\/div>/gs)

  authors.forEach((author, i) => {
    tracks[i].info.author = author.split('by')[1].split('</div>')[0].trim()
  })

  const artworkUrls = data.match(/<div class="art">\s*<img src="(.+?)"/gs)

  artworkUrls.forEach((artworkUrl, i) => {
    tracks[i].info.artworkUrl = artworkUrl.split('"')[3].split('"')[0]
  })

  const urls = data.match(/<div class="itemurl">\s+<a.*?>(.*?)<\/a>/gs)

  urls.forEach((url, i) => {
    tracks[i].info.uri = url.split('">')[2].split('</a>')[0]
    
    const identifier = tracks[i].info.uri.match(/^https?:\/\/([^/]+)\/track\/([^/?]+)/)
    tracks[i].info.identifier = `${identifier[1]}:${identifier[2]}`

    tracks[i].encoded = encodeTrack(tracks[i].info)
    tracks[i].pluginInfo = {}
  })

  if (shouldLog) debugLog('search', 4, { type: 2, sourceName: 'BandCamp', tracksLen: tracks.length, query })

  return {
    loadType: 'search',
    data: tracks
  }
}

async function retrieveStream(uri, title) {
  const { body: data } = await makeRequest(uri, { method: 'GET' })

  const streamURL = data.match(/https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/)

  if (!streamURL) {
    debugLog('retrieveStream', 4, { type: 2, sourceName: 'BandCamp', query: title, message: 'No stream URL was found.' })

    return {
      exception: {
        message: 'Failed to get the stream from source.',
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  return {
    url: streamURL[0],
    protocol: 'https',
    format: 'mp3'
  }
}

export default {
  loadFrom,
  search,
  retrieveStream
}