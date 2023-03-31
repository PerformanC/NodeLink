import config from '../config.js'
import utils from './utils.js'
import https from 'https'
import zlib from 'zlib'
import fs from 'fs'
let playerInfo = {}

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

function startInnertube() {
  playerInfo.innertubeInterval = setIntervalNow(async () => {
    console.log('[NodeLink]: Fetching YouTube embed page...')
  
    const data = await utils.nodelink_makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink]: Failed to fetch innertube data: ${err.message}`)
    })
      
    const innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
    playerInfo.innertube = innertube.INNERTUBE_CONTEXT
    playerInfo.innertube.client.clientName = 'WEB',
    playerInfo.innertube.client.clientVersion = '2.20230316.00.00'
    playerInfo.innertube.client.originalUrl = 'https://www.youtube.com/'

    console.log('[NodeLink]: Sucessfully extracted InnerTube Context. Fetching player.js...')

    const player = await utils.nodelink_makeRequest(`https://www.youtube.com${innertube.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER.jsUrl}`, { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink]: Failed to fetch player js: ${err.message}`)
    })

    console.log('[NodeLink]: Fetch player.js from YouTube.')
  
    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]
  
    let dFunctionHighLevel = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
    dFunctionHighLevel = ('function decipher(a)' + player.split(`${dFunctionHighLevel}=function(a)`)[1].split(')};')[0] + ')};')
    let decipherLowLevel = player.split('this.audioTracks};')[1].split(')};var ')[1].split(')}};')[0]

    playerInfo.decipherEval = `const ${decipherLowLevel})}};${dFunctionHighLevel}decipher('NODELINK_DECIPHER_URL');`

    console.log('[NodeLink]: Successfully processed information for next loadtracks and play.')
  }, 120000)
}

function stopInnertube() {
  clearInterval(playerInfo.innertubeInterval)
}

function checkYouTubeURLType(url) {
  const videoRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/;
  const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/;
  const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/;
  
  if (videoRegex.test(url)) return 2
  else if (playlistRegex.test(url)) return 3
  else if (shortsRegex.test(url)) return 4
  else return -1
}

async function searchOnYoutube(query, type) {
  switch (type) {
    case 1: {
      const search = await utils.nodelink_makeRequest('https://www.youtube.com/youtubei/v1/search', {
        method: 'POST',
        body: {
          context: playerInfo.innertube,
          query: query,
        }
      })

      if (search.error) {
        console.log(`[NodeLink]: Failed to search for "${query}": ${search.error.message}`)

        return {
          loadType: 'LOAD_FAILED',
          playlistInfo: null,
          tracks: [],
          exception: {
            severity: 'COMMON',
            message: search.error.message
          }
        }
      }
      
      let tracks = []
      let i = 0

      let videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
      if (videos[0].adSlotRenderer) videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[1].itemSectionRenderer.contents
        
      videos.forEach((item) => {
        if (item.videoRenderer) {
          item = item.videoRenderer

          const infoObj = {
            identifier: item.videoId,
            isSeekable: true,
            author: item.ownerText.runs[0].text,
            length: item.lengthText ? parseInt(item.lengthText.simpleText.split(':').map((v, i) => v * (60 ** (2 - i))).reduce((a, b) => a + b)) * 1000 : 0,
            isStream: item.lengthText ? false : true,
            position: i++,
            title: item.title.runs[0].text,
            uri: `https://www.youtube.com/watch?v=${item.videoId}`,
            artworkUrl: `https://i.ytimg.com/vi/${item.videoId}/maxresdefault.jpg`,
            isrc: null,
            sourceName: 'youtube'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })
        }
      })

      if (tracks.length == 0)
        console.log(`[NodeLink]: No matches found for "${identifier}".`)

      return {
        loadType: tracks.length == 0 ? 'NO_MATCHES' : 'SEARCH_RESULT',
        playlistInfo: null,
        tracks: tracks,
        exception: null
      }
    }
    case 2: {
      const video = await utils.nodelink_makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
        method: 'POST',
        body: {
          context: playerInfo.innertube,
          videoId: /(?:\?v=)(\w+)/.exec(query)[1],
        }
      })

      if (video.playabilityStatus.status == 'ERROR') {
        console.log(`[NodeLink]: Failed to load track: ${video.playabilityStatus.reason}`)
        return {
          loadType: 'LOAD_FAILED',
          playlistInfo: null,
          tracks: [],
          exception: {
            severity: 'COMMON',
            message: video.playabilityStatus.reason
          }
        }
      }

      const infoObj = {
        identifier: video.videoDetails.videoId,
        isSeekable: true,
        author: video.videoDetails.author,
        length: parseInt(video.videoDetails.lengthSeconds) * 1000,
        isStream: false,
        position: 0,
        title: video.videoDetails.title,
        uri: `https://www.youtube.com/watch?v=${video.videoDetails.videoId}`,
        artworkUrl: `https://i.ytimg.com/vi/${video.videoDetails.videoId}/maxresdefault.jpg`,
        isrc: null,
        sourceName: 'youtube'
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
    case 3: {
      const playlist = await utils.nodelink_makeRequest('https://www.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
        method: 'POST',
        body: {
          context: playerInfo.innertube,
          playlistId: /(?<=list=)[\w-]+/.exec(query)[0]
        }
      })

      if (!playlist.contents.twoColumnWatchNextResults.playlist) {
        console.log(`[NodeLink]: Failed to load playlist.`)
        return {
          loadType: 'LOAD_FAILED',
          playlistInfo: null,
          tracks: [],
          exception: {
            severity: 'COMMON',
            message: 'Failed to load playlist.'
          }
        }
      }
      
      let tracks = []
      let i = 0

      playlist.contents.twoColumnWatchNextResults.playlist.playlist.contents.forEach((item) => {
        if (item.playlistPanelVideoRenderer) {
          item = item.playlistPanelVideoRenderer

          const infoObj = {
            identifier: item.videoId,
            isSeekable: true,
            author: item.shortBylineText.runs[0].text,
            length: item.lengthText ? parseInt(item.lengthText.simpleText.split(':').map((v, i) => v * (60 ** (2 - i))).reduce((a, b) => a + b)) * 1000 : 0,
            isStream: false,
            position: i++,
            title: item.title.simpleText,
            uri: `https://www.youtube.com/watch?v=${item.videoId}`,
            artworkUrl: `https://i.ytimg.com/vi/${item.videoId}/maxresdefault.jpg`,
            isrc: null,
            sourceName: 'youtube'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })
        }
      })

      return {
        loadType: 'PLAYLIST_LOADED',
        playlistInfo: {
          name: playlist.contents.twoColumnWatchNextResults.playlist.playlist.title,
          selectedTrack: 0
        },
        tracks: tracks,
        exception: null
      }
    }
    case 4: {
      const short = await utils.nodelink_makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
        method: 'POST',
        body: {
          context: playerInfo.innertube,
          videoId: /shorts\/([a-zA-Z0-9_-]+)/.exec(query)[1]
        }
      })

      if (short.playabilityStatus.status == 'ERROR') {
        console.log(`[NodeLink]: Failed to load track: ${short.playabilityStatus.reason}`)

        return {
          loadType: 'LOAD_FAILED',
          playlistInfo: null,
          tracks: [],
          exception: {
            severity: 'COMMON',
            message: short.playabilityStatus.reason
          }
        }
      }

      const infoObj = {
        identifier: short.videoDetails.videoId,
        isSeekable: true,
        author: short.videoDetails.author,
        length: parseInt(short.videoDetails.lengthSeconds) * 1000,
        isStream: false,
        position: 0,
        title: short.videoDetails.title,
        uri: `https://www.youtube.com/watch?v=${short.videoDetails.videoId}`,
        artworkUrl: `https://i.ytimg.com/vi/${short.videoDetails.videoId}/maxresdefault.jpg`,
        isrc: null,
        sourceName: 'youtube'
      }

      return {
        loadType: 'SHORT_LOADED',
        playlistInfo: null,
        tracks: [{
          encoded: utils.nodelink_encodeTrack(infoObj),
          info: infoObj
        }],
        exception: null
      }
    }
  }
}

async function getTrackURL(track) {
  return new Promise(async (resolve, reject) => {
    if ([ 'deezer', 'spotify' ].includes(track.sourceName)) track.sourceName = config.search.defaultSearchSource

    switch (track.sourceName) {
      case 'soundcloud': {
        const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${track.identifier}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })
      
        if (data.errors) {
          console.log(`[NodeLink]: Failed to load track: ${data.errors[0].error_message}`)

          reject()
        }

        data.media.transcodings.forEach(async (transcoding) => {
          if (transcoding.format.protocol == 'progressive') {
            const stream = await utils.nodelink_http1makeRequest(transcoding.url + `?client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

            resolve(stream.url)
          }
        })

        break
      }
      case 'bandcamp': {
        const data = await utils.nodelink_makeRequest(track.uri, { method: 'GET' })

        const streamURL = data.match(/https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/)

        if (!streamURL) {
          console.log(`[NodeLink]: Failed to load track: No stream URL found.`)

          reject()
        }

        resolve(streamURL[0])

        break
      }
      default: {
        const videos = await utils.nodelink_makeRequest(`https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
          body: {
            context: playerInfo.innertube,
            videoId: track.identifier,
            playbackContext: {
              contentPlaybackContext: {
                signatureTimestamp: playerInfo.signatureTimestamp
              }
            }
          },
          method: 'POST'
        })
  
        if (videos.playabilityStatus.status != 'OK') {
          console.log('[NodeLink]: The track is not playable, this is not a NodeLink issue.')
  
          return null
        }
  
        const audio = videos.streamingData.adaptiveFormats[videos.streamingData.adaptiveFormats.length - 1]
        let url = audio.url
  
        if (audio.signatureCipher) {
          url = audio.signatureCipher.split('&')
        
          const signature = eval(playerInfo.decipherEval.replace('NODELINK_DECIPHER_URL', decodeURIComponent(url[0].replace('s=', ''))))
  
          url = `${decodeURIComponent(url[2].replace('url=', ''))}&${url[1].replace('sp=', '')}=${signature}&sts=${playerInfo.signatureTimestamp}`
  
          console.log('[NodeLink]: Started playing track protected by cipher signature')
        } else {
          console.log('[NodeLink]: Started playing track with no cipher signature')
        }
  
        resolve(url)
  
        break
      }
    }
  })
}

async function searchOnSoundcloud(query) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from SoundCloud: ${query}`)

    const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${config.search.sources.soundcloud.clientId}&limit=10&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`, {
      method: 'GET'
    })
    
    if (data.error) {
      if (data.error.status == 400) 
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

      resolve({ loadType: 'LOAD_FAILED', playlistInfo: {}, tracks: [], exception: { message: data.error.message, severity: 'UNKNOWN' } })
    }

    const tracks = []
    let i = 0

    data.collection.forEach(async (track, index) => {
      if (track.kind == 'track') {
        const infoObj = {
          identifier: track.id.toString(),
          isSeekable: true,
          author: track.user.username,
          length: track.duration,
          isStream: false,
          position: i++,
          title: track.title,
          uri: track.uri,
          artworkUrl: track.artwork_url,
          isrc: null,
          sourceName: 'soundcloud'
        }

        tracks.push({
          encoded: utils.nodelink_encodeTrack(infoObj),
          info: infoObj
        })
      }

      if (index == data.collection.length - 1) {
        resolve({
          loadType: 'SEARCH_RESULT',
          playlistInfo: null,
          tracks,
          exception: null
        })
      }
    })
  })
}

async function loadFromSoundCloud(url) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from SoundCloud: ${url}`)

    const data = await utils.nodelink_http1makeRequest(`https://api-v2.soundcloud.com/resolve?url=${encodeURI(url)}&client_id=${config.search.sources.soundcloud.clientId}`, { method: 'GET' })

    if (data.error) {
      if (data.error.status == 400) 
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

      resolve({ loadType: 'LOAD_FAILED', playlistInfo: {}, tracks: [], exception: { message: data.error.message, severity: 'UNKNOWN' } })
    }

    switch (data.kind) {
      case 'track': {
        const infoObj = {
          identifier: data.id.toString(),
          isSeekable: true,
          author: data.user.username,
          length: data.duration,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.permalink_url,
          artworkUrl: data.artwork_url,
          isrc: null,
          sourceName: 'soundcloud'
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

        break
      }
      case 'playlist': {
        const tracks = []

        data.tracks.forEach(async (track, index) => {
          const infoObj = {
            identifier: track.id.toString(),
            isSeekable: true,
            author: track.user.username,
            length: track.duration,
            isStream: false,
            position: index,
            title: track.title,
            uri: track.permalink_url,
            artworkUrl: track.artwork_url,
            isrc: null,
            sourceName: 'soundcloud'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })

          if (index == data.tracks.length - 1) {
            resolve({
              loadType: 'PLAYLIST_LOADED',
              playlistInfo: {
                name: data.title,
                selectedTrack: 0,
              },
              tracks,
              exception: null
            })
          }
        })

        break
      }
    }
  })
}

async function searchOnBandcamp(query) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from BandCamp: ${query}`)

    const data = await utils.nodelink_makeRequest(`https://bandcamp.com/search?q=${encodeURI(query)}&item_type=t&from=results`, { method: 'GET' })

    let matches = data.matchAll(/<div class="heading">\s+<a.*?>(.*?)<\/a>/gs)

    if (!matches)
      resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

    const tracks = []
    let i = 0
    
    for (const match of matches) {
      if (i >= config.options.maxResults) break

      tracks.push({
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

    matches = data.match(/<div class="subhead">\s+by\s+(.*?)\s+<\/div>/gs)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.author = matches[i].split('by')[1].split('</div>')[0].trim()
    }

    matches = data.match(/<div class="art">\s*<img src="(.+?)"/g)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.artworkUrl = matches[i].split('"')[3].split('"')[0]
    }

    matches = data.match(/<div class="itemurl">\s+<a.*?>(.*?)<\/a>/gs)

    for (i = 0; i <= tracks.length - 1; i++) {
      tracks[i].info.uri = matches[i].split('"')[3].split('?from=')[0]
      
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

async function loadFromBandcamp(url) {
  return new Promise(async (resolve) => {
    console.log(`[NodeLink]: Loading track from BandCamp: ${url}`)

    const data = await utils.nodelink_makeRequest(url, { method: 'GET' })

    let matches = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(data)

    if (!matches)
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

async function searchWithDefault(query) {
  switch (config.search.defaultSearchSource) {
    case 'youtube': {
      console.log('[NodeLink]: Default search source: YouTube, searching...')
      return searchOnYoutube(query, 1)
    }
    case 'soundcloud': {
      console.log('[NodeLink]: Default search source: SoundCloud, searching...')
      return searchOnSoundcloud(query)
    }
    case 'bandcamp': {
      console.log('[NodeLink]: Default search source: Bandcamp, searching...')
      return searchOnBandcamp(query)
    }
    default: {
      console.log('[NodeLink]: Default search source: unknown, stopping...')
      throw Error('Unknown default search source')
    }
  }
}

async function setSpotifyToken() {
  const token = await utils.nodelink_makeRequest('https://open.spotify.com/get_access_token', {
    method: 'GET'
  })

  const req = https.request({
    hostname: 'clienttoken.spotify.com',
    path: '/v1/clienttoken',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://open.spotify.com/',
      'Content-Type': 'application/json',
      'Origin': 'https://open.spotify.com',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site'
    }
  }, (res) => {
    let data = ''

    const compression = zlib.createGunzip()
    res.pipe(compression)
  
    compression.on('data', (chunk) => data += chunk)
  
    compression.on('end', () => {
      data = JSON.parse(data)

      if (data.response_type == 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
        playerInfo.spotify = {
          accessToken: token.accessToken,
          clientToken: data.granted_token.token
        }
      }
    })
  })
  
  req.on('error', (error) => {
    console.error(error)
  })
  
  req.write(JSON.stringify({
    client_data: {
      client_version: '1.2.9.2269.g2fe25d39',
      client_id: 'd8a5ed958d274c2e8ee717e6a4b0971d',
      js_sdk_data: {
        device_brand: 'unknown',
        device_model: 'unknown',
        os: 'linux',
        os_version: 'unknown',
        device_id: '0c5f7c36-855e-4d0a-a661-1a79958ee6de',
        device_type: 'computer'
      }
    }
  }))
  req.end()
}

async function searchOnSpotify(query) {
  return new Promise(async (resolve) => {
    https.get({
      hostname: 'api-partner.spotify.com',
      path: `/pathfinder/v1/query?operationName=searchDesktop&variables=%7B%22searchTerm%22%3A%22${encodeURI(query)}%22%2C%22offset%22%3A0%2C%22limit%22%3A10%2C%22numberOfTopResults%22%3A5%2C%22includeAudiobooks%22%3Atrue%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%221d3a8f81abf4f33f49d1e389ed0956761af669eedb62a050c6c7bce5c66070bb%22%7D%7D`,
      method: 'GET',
      headers: {
        'Host': 'api-partner.spotify.com',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
        'Accept': 'application/json',
        'Accept-Language': 'en',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://open.spotify.com/',
        'authorization': `Bearer ${playerInfo.spotify.accessToken}`,
        'app-platform': 'WebPlayer',
        'spotify-app-version': '1.2.9.1649.gd4540f47',
        'content-type': 'application/json;charset=UTF-8',
        'client-token': playerInfo.spotify.clientToken,
        'Origin': 'https://open.spotify.com',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    }, (res) => {
      let data = ''

      const compression = zlib.createGunzip()
      res.pipe(compression)
    
      compression.on('data', (chunk) => data += chunk)
    
      compression.on('end', () => {
        data = JSON.parse(data)

        if (data.data.searchV2.tracksV2.totalCount == 0)
          resolve({ loadType: 'NO_MATCHES', playlistInfo: null, tracks: [], exception: null })
          
        let tracks = []
        let i = 0

        data.data.searchV2.tracksV2.items.forEach(async (track, index) => {
          if (track) {
            track = track.item.data

            const search = await searchWithDefault(`${track.name} ${track.artists.items[0].profile.name}`)

            if (search.loadType == 'NO_MATCHES')
              resolve(search)

            const infoObj = {
              identifier: search.tracks[0].info.identifier,
              isSeekable: true,
              author: track.artists.items.map((artist) => artist.profile.name).join(', '),
              length: track.duration.totalMilliseconds,
              isStream: false,
              position: i++,
              title: track.name,
              uri: track.uri,
              artworkUrl: track.albumOfTrack.coverArt.sources[0].url,
              isrc: null,
              sourceName: 'spotify'
            }

            tracks.push({
              encoded: utils.nodelink_encodeTrack(infoObj),
              info: infoObj
            })
          }

          if (index == data.data.searchV2.tracksV2.items.length - 1)
            resolve({
              loadType: 'SEARCH_RESULT',
              playlistInfo: null,
              tracks,
              exception: null
            })
        })
      })
    })
  })    
}

async function loadFromSpotify(query) {
  return new Promise(async (resolve, reject) => {
    const spotifyRegex = /(?:https:\/\/open\.spotify\.com\/|spotify:)(?:.+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/

    let type = spotifyRegex.exec(query)
    let endpoint

    switch (type[1]) {
      case 'track': {
        endpoint = `/tracks/${type[2]}`
        break
      }
      case 'playlist': {
        endpoint = `/playlists/${type[2]}`
        break
      }
      case 'album': {
        endpoint = `/albums/${type[2]}`
        break
      }
      case 'episodes': {
        endpoint = `/episodes/${type[2]}?market=${Infos.Configs.SpotifyMarket}`
        break
      }
      case 'show': {
        endpoint = `/shows/${type[2]}?market=US`
        break
      }
      default: {
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [] })
      }
    }

    console.log(`[NodeLink]: Loading track from Spotify: ${endpoint}`)

    let data = await utils.nodelink_makeRequest(`https://api.spotify.com/v1${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${playerInfo.spotifyToken}`
      }
    })

    if (data.error) {
      if (data.error.status == 401) {
        setSpotifyToken()

        data = await utils.nodelink_makeRequest(`https://api.spotify.com/v1${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${playerInfo.spotifyToken}`
          }
        })
      }

      if (data.error.status == 400) 
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })
    
      if (data.error)
        resolve({ loadType: 'LOAD_FAILED', playlistInfo: {}, tracks: [], exception: { message: data.error.message, severity: 'UNKNOWN' } })
    }

    switch (type[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.name} ${data.artists[0].name}"`)

        if (search.loadType == 'LOAD_FAILED')
          resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.artists[0].name,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.album.images[0].url,
          isrc: null,
          sourceName: 'spotify'
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

        break
      }
      case 'episode': {
        const search = await searchWithDefault(`"${data.name} ${data.publisher}"`)

        if (search.loadType == 'LOAD_FAILED')
          resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.publisher,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.images[0].url,
          isrc: null,
          sourceName: 'spotify'
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

        break
      }
      case 'playlist':
      case 'album': {
        const tracks = []

        data.tracks.items.forEach(async (track, index) => {
          let search
          if (type[1] == 'playlist') search = await searchWithDefault(`"${track.track.name} ${track.track.artists[0].name}"`)
          else search = await searchWithDefault(`"${track.name} ${track.artists[0].name}"`)

          if (search.loadType == 'LOAD_FAILED')
            resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: type[1] == 'playlist' ? track.track.artists[0].name : track.artists[0].name,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: type[1] == 'playlist' ? track.track.name : track.name,
            uri: type[1] == 'playlist' ? track.track.external_urls.spotify : track.external_urls.spotify,
            artworkUrl: type[1] == 'playlist' ? data.images[0].url : data.images[0].url,
            isrc: null,
            sourceName: 'spotify'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })

          if (index == data.tracks.items.length - 1) {
            resolve({
              loadType: 'PLAYLIST_LOADED',
              playlistInfo: {
                name: type[1] == 'playlist' ? data.name : data.name,
                selectedTrack: 0,
              },
              tracks,
              exception: null
            })
          }
        })

        break
      }
      case 'show': {
        const tracks = []

        data.episodes.items.forEach(async (episode, index) => {
          const search = await searchWithDefault(`"${episode.name} ${episode.publisher}"`)

          if (search.loadType == 'LOAD_FAILED')
            resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: episode.publisher,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: episode.name,
            uri: episode.external_urls.spotify,
            artworkUrl: episode.images[0].url,
            isrc: null,
            sourceName: 'spotify'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })

          if (index == data.episodes.items.length - 1) {
            resolve({
              loadType: 'PLAYLIST_LOADED',
              playlistInfo: {
                name: data.name,
                selectedTrack: 0,
              },
              tracks,
              exception: null
            })
          }
        })

        break
      }
    }
  })
}

async function loadFromDeezer(query) {
  return new Promise(async (resolve) => {
    const track = /^https?:\/\/(?:www\.)?deezer\.com\/(track|album|playlist)\/(\d+)$/.exec(query)
    let endpoint

    switch (track[1]) {
      case 'track': 
        endpoint = `track/${track[2]}`
        break
      case 'playlist': 
        endpoint = `playlist/${track[2]}`
        break
      case 'album': 
        endpoint = `album/${track[2]}`
        break
      default:
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [] })
    }

    console.log(`[NodeLink]: Loading track from Deezer: ${endpoint}`)

    const data = await utils.nodelink_makeRequest(`https://api.deezer.com/${endpoint}`, { method: 'GET' })

    if (data.error) {
      if (data.error.status == 400) 
        resolve({ loadType: 'NO_MATCHES', playlistInfo: {}, tracks: [], exception: null })

      resolve({ loadType: 'LOAD_FAILED', playlistInfo: {}, tracks: [], exception: { message: data.error.message, severity: 'UNKNOWN' } })
    }

    switch (track[1]) {
      case 'track': {
        const search = await searchWithDefault(`"${data.title} ${data.artist.name}"`)

        if (search.loadType == 'LOAD_FAILED')
          resolve(search)

        const infoObj = {
          identifier: search.tracks[0].info.identifier,
          isSeekable: true,
          author: data.artist.name,
          length: search.tracks[0].info.length,
          isStream: false,
          position: 0,
          title: data.title,
          uri: data.link,
          artworkUrl: data.album.cover_xl,
          isrc: null,
          sourceName: 'deezer'
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

        break
      }
      case 'album':
      case 'playlist': {
        const tracks = []

        data.tracks.data.forEach(async (track, index) => {
          const search = await searchWithDefault(`"${track.title} ${track.artist.name}"`)

          if (search.loadType == 'LOAD_FAILED')
            resolve(search)

          const infoObj = {
            identifier: search.tracks[0].info.identifier,
            isSeekable: true,
            author: track.artist.name,
            length: search.tracks[0].info.length,
            isStream: false,
            position: index,
            title: track.title,
            uri: track.link,
            artworkUrl: track[1] == 'album' ? data.cover_xl : data.picture_xl,
            isrc: null,
            sourceName: 'deezer'
          }

          tracks.push({
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          })

          if (index == data.tracks.data.length) 
            resolve({
              loadType: 'PLAYLIST_LOADED',
              playlistInfo: {
                name: data.title,
                selectedTrack: 0,
              },
              tracks,
              exception: null
            })
        })

        break
      }
    }
  })
}

export default { startInnertube, stopInnertube, checkYouTubeURLType, searchOnYoutube, getTrackURL, searchOnSoundcloud, loadFromSoundCloud, searchOnBandcamp, loadFromBandcamp, setSpotifyToken, searchOnSpotify, loadFromSpotify, loadFromDeezer }