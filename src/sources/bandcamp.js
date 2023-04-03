import config from '../../config.js'
import utils from '../utils.js'

import fs from 'fs'

async function loadFrom(url) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from BandCamp: ${url}`)

    const data = await utils.nodelink_makeRequest(url, { method: 'GET' })

    let matches = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(data)

    if (!matches.length)
      resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

    const information = JSON.parse(matches[1])
    const identifier = url.match(/^https?:\/\/([^.]+)\.bandcamp\.com\/track\/([^/?]+)/)

    const infoObj = {
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

    resolve({
      loadType: 'TRACK_LOADED',
      playlistInfo: null,
      tracks: [{
        encoded: utils.nodelink_encodeTrack(infoObj),
        info: infoObj
      }],
      exception: null
    })
  })
}

async function search(query) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Searching track from BandCamp: ${query}`)

    const data = await utils.nodelink_makeRequest(`https://bandcamp.com/search?q=${encodeURI(query)}&item_type=t&from=results`, { method: 'GET' })

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
      return resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

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

      tracks[i].encoded = utils.nodelink_encodeTrack(tracks[i].info)
    }

    resolve({
      loadType: 'SEARCH_RESULT',
      playlistInfo: null,
      tracks,
      exception: null
    })
  })
}

async function retrieveStream(uri) {
  return new Promise(async (resolve) => {
    const data = await utils.nodelink_makeRequest(uri, { method: 'GET' })

    const streamURL = data.match(/https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/)

    if (!streamURL) {
      console.log(`[NodeLink]: Failed to load track: No stream URL found.`)

      reject()
    }

    resolve(streamURL[0])
  })
}

export default {
  loadFrom,
  search,
  retrieveStream
}