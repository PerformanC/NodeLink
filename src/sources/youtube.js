import config from '../../config.js'
import utils from '../utils.js'

import vm from 'node:vm'
import { URLSearchParams } from 'node:url'

let playerInfo = {
  innertube: null,
  innertubeInterval: null,
  signatureTimestamp: null,
  functions: [],
  cache: {}
}

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

function startInnertube() {
  playerInfo.cache = {
    cpn: utils.randomLetters(16),
    t: utils.randomLetters(12)
  }

  playerInfo.innertubeInterval = setIntervalNow(async () => {
    utils.debugLog('innertube', 5, { type: 1, message: 'Fetching innertube data...' })
 
    const data = await utils.makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      utils.debugLog('innertube', 5, { type: 2, message: `Failed to fetch innertube data: ${err.message}` })
    })

    const innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
    playerInfo.innertube = innertube.INNERTUBE_CONTEXT
    playerInfo.innertube.client.clientName = 'ANDROID',
    playerInfo.innertube.client.clientVersion = '17.29.34'
    playerInfo.innertube.client.originalUrl = 'https://www.youtube.com/'
    playerInfo.innertube.client.androidSdkVersion = '33'
    playerInfo.innertube.client.screenDensityFloat = 1
    playerInfo.innertube.client.screenWidthPoints = 1080
    playerInfo.innertube.client.screenPixelDensity = 1
    playerInfo.innertube.client.screenWidthPoints = 1920

    utils.debugLog('innertube', 5, { type: 1, message: 'Fetched innertube data, fetching player.js...' })

    const player = await utils.makeRequest(`https://www.youtube.com${innertube.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER.jsUrl}`, { method: 'GET' }).catch((err) => {
      utils.debugLog('innertube', 5, { type: 2, message: `Failed to fetch player js: ${err.message}` })
    })

    utils.debugLog('innertube', 5, { type: 1, message: 'Fetched player.js, parsing...' })
  
    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]

    let functionName = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
    const decipherFunctionName = functionName

    const sigFunction = `function ${decipherFunctionName}(a)${player.split(`${functionName}=function(a)`)[1].split(')};')[0]}`
  
    functionName = player.split('a=a.split("");')[1].split('.')[0]
    const sigWrapper = player.split(`var ${functionName}={`)[1].split('};')[0]

    playerInfo.functions.push(new vm.Script(`var ${functionName}={${sigWrapper}};${sigFunction})};${decipherFunctionName}(sig);`))
    
    functionName = player.split('&&(b=a.get("n"))&&(b=')[1].split('(b)')[0]
    if (functionName.includes('[')) functionName = player.split(`${functionName.split('[')[0]}=[`)[1].split(']')[0]

    const ncodeFunction = player.split(`${functionName}=function`)[1].split(')};')[0] + ')'
    playerInfo.functions.push(new vm.Script(`const decipherNcode = function${ncodeFunction}};decipherNcode(ncode)`))
//    playerInfo.functions.push(new vm.Script(`const ${functionName} = function${ncodeFunction}};${functionName}(ncode)`))

    utils.debugLog('innertube', 5, { type: 1, message: 'Extracted signatureTimestamp, decipher signature and ncode functions.' })
  }, 3600000)
}

function stopInnertube() {
  clearInterval(playerInfo.innertubeInterval)
}

function checkURLType(url, type) {
  if (type == 'ytmusic') {
    const videoRegex = /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/
    const playlistRegex = /^https?:\/\/music\.youtube\.com\/playlist\?list=[\w-]+/
    
    if (playlistRegex.test(url)) return 3
    else if (videoRegex.test(url)) return 2
    else return -1
  } else {
    const videoRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/
    const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/
    const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/
  
    if (playlistRegex.test(url)) return 3
    else if (shortsRegex.test(url)) return 4
    else if (videoRegex.test(url)) return 2
    else return -1
  }
}

async function search(query, type) {
  return new Promise(async (resolve) => {
    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      await utils.sleep(200)
    }

    utils.debugLog('search', 4, { type: 1, sourceName: 'YouTube', query })

    const search = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/search`, {
      method: 'POST',
      body: {
        context: playerInfo.innertube,
        query,
        params: 'EgIQAQ%3D%3D'
      }
    })

    if (search.error) {
      utils.debugLog('search', 4, { type: 3, sourceName: 'YouTube', query, message: search.error.message })

      return resolve({ loadType: 'error', data: { message: search.error.message, severity: 'suspicious', cause: 'unknown' } })
    }

    const tracks = []
    let i = 0

    search.contents.sectionListRenderer.contents[0].itemSectionRenderer.contents.forEach((video) => {
      video = video.compactVideoRenderer

      if (video) {
        const track = {
          identifier: video.videoId,
          isSeekable: true,
          author: video.longBylineText.runs[0].text,
          length: video.lengthText ? parseInt(video.lengthText.runs[0].text.split(':').map((v, i) => v * (60 ** (2 - i))).reduce((a, b) => a + b)) * 1000 : 0,
          isStream: video.lengthText ? false : true,
          position: i++,
          title: video.title.runs[0].text,
          uri: `https://www.youtube.com/watch?v=${video.videoId}`,
          artworkUrl: `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
          isrc: null,
          sourceName: type
        }

        tracks.push({
          encoded: utils.encodeTrack(track),
          info: track
        })
      }
    })

    if (tracks.length == 0) {
      utils.debugLog('search', 4, { type: 3, sourceName: 'YouTube', query, message: 'No matches found.' })

      return resolve({ loadType: 'empty', data: {} })
    }

    if (tracks.length > config.options.maxResultsLength) tracks.length = config.options.maxResults

    utils.debugLog('search', 4, { type: 2, sourceName: 'YouTube', tracksLen: tracks.length, query })

    return resolve({ loadType: 'search', data: tracks })
  })
}

async function loadFrom(query, type) {
  return new Promise(async (resolve) => {
    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      await utils.sleep(200)
    }

    switch (checkURLType(query, type)) {
      case 2: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube', query })
        
        const identifier = /v=([^&]+)/.exec(query)[1]

        const video = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
          body: {
            context: playerInfo.innertube,
            videoId: identifier,
            playbackContext: {
              contentPlaybackContext: {
                signatureTimestamp: playerInfo.signatureTimestamp
              },
            },
            cpn: playerInfo.cache.cpn,
            contentCheckOk: true,
            racyCheckOk: true,
            params: 'CgIQBg'
          },
          method: 'POST'
        })

        if (video.playabilityStatus.status != 'OK') {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube', query, message: video.playabilityStatus.reason || video.playabilityStatus.messages[0] })
          
          return resolve({ loadType: 'error', data: { message: video.playabilityStatus.reason || video.playabilityStatus.messages[0], severity: 'suspicious', cause: 'unknown' } })
        }

        const track = {
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
          sourceName: type
        }

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube', track, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: utils.encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }
      case 3: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'playlist', sourceName: 'YouTube', query })

        const playlist = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            playlistId: /(?<=list=)[\w-]+/.exec(query)[0],
            cpn: playerInfo.cache.cpn,
            contentCheckOk: true,
            racyCheckOk: true,
            params: 'CgIQBg'
          }
        })

        if (!playlist.contents.twoColumnWatchNextResults.playlist) {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'YouTube', query, message: 'Failed to load playlist.' })
        
          return resolve({ loadType: 'error', data: { message: 'Failed to load playlist.', severity: 'suspicious', cause: 'unknown' } })
        }
      
        const tracks = []
        let i = 0

        playlist.contents.twoColumnWatchNextResults.playlist.playlist.contents.forEach((item, index) => {
          item = item.playlistPanelVideoRenderer

          if (item) {
            const track = {
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
              encoded: utils.encodeTrack(track),
              info: track,
              pluginInfo: {}
            })
          }
        })

        if (tracks.length == 0) {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'YouTube', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }

        if (tracks.length > config.options.maxAlbumPlaylistLength) tracks.length = config.options.maxAlbumPlaylistLength

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'YouTube', tracksLen: tracks.length, query })

        return resolve({
          loadType: 'playlist',
          data: {
            info: {
              name: playlist.contents.twoColumnWatchNextResults.playlist.playlist.title,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        })
      }
      case 4: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube Shorts', query })

        const short = await utils.makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            videoId: /shorts\/([a-zA-Z0-9_-]+)/.exec(query)[1],
            cpn: playerInfo.cache.cpn,
            contentCheckOk: true,
            racyCheckOk: true,
            params: 'CgIQBg'
          }
        })

        if (short.playabilityStatus.status != 'OK') {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube Shorts', query, message: short.playabilityStatus.reason || short.playabilityStatus.messages[0] })

          return resolve({ loadType: 'error', data: { message: short.playabilityStatus.reason || short.playabilityStatus.messages[0], severity: 'suspicious', cause: 'unknown' } })
        }

        const track = {
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

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube Shorts', track, query })

        return resolve({
          loadType: 'short',
          data: {
            encoded: utils.encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }

      default: {
        utils.debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: 'YouTube', query, message: 'No matches found.' })

        return resolve({ loadType: 'empty', data: {} })
      }
    }
  })
}

async function retrieveStream(identifier, type) {
  return new Promise(async (resolve) => {
    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      await utils.sleep(200)
    }

    const videos = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false&t=${utils.randomLetters(12)}&id=${identifier}`, {
      body: {
        context: playerInfo.innertube,
        videoId: identifier,
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: playerInfo.signatureTimestamp
          }
        },
        cpn: playerInfo.cache.cpn,
        contentCheckOk: true,
        racyCheckOk: true,
        params: 'CgIQBg'
      },
      method: 'POST'
    })

    if (videos.playabilityStatus.status != 'OK') {
      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'YouTube', query: identifier, message: videos.playabilityStatus.reason })

      return resolve({ exception: { message: videos.playabilityStatus.reason, severity: 'suspicious', cause: 'unknown' } })
    }

    let itag = null
    switch (config.audio.quality) {
      case 'high': itag = 251; break
      case 'medium': itag = 250; break
      case 'low': itag = 249; break
      default: itag = 251; break
    }

    const audio = videos.streamingData.adaptiveFormats.find((format) => format.itag == itag)
    let url = audio.url

    if (audio.signatureCipher) {
      const args = new URLSearchParams(audio.signatureCipher)

      const components = new URL(decodeURIComponent(args.get('url')))
      components.searchParams.set(args.get('sp'), playerInfo.functions[0].runInNewContext({ sig: decodeURIComponent(args.get('s')) }))

      url = components.toString()
    }

    resolve({ url, protocol: 'https' })
  })
}

async function loadCaptions(decodedTrack) {
  return new Promise(async (resolve) => {
    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      await utils.sleep(200)
    }

    const video = await utils.makeRequest(`https://${decodedTrack.sourceName == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
      body: {
        context: playerInfo.innertube,
        videoId: decodedTrack.identifier,
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: playerInfo.signatureTimestamp
          }
        },
        cpn: playerInfo.cache.cpn,
        contentCheckOk: true,
        racyCheckOk: true,
        params: 'CgIQBg'
      },
      method: 'POST'
    })

    if (video.playabilityStatus.status != 'OK') {
      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'YouTube', query: decodedTrack.title, message: video.playabilityStatus.reason })

      return resolve({ loadType: 'error', data: { message: video.playabilityStatus.reason, severity: 'suspicious', cause: 'unknown' } })
    }

    const captions = video.captions.playerCaptionsTracklistRenderer.captionTracks.map((caption) => {
      return {
        name: caption.name.simpleText,
        url: caption.baseUrl.replace('&fmt=srv3', '&fmt=json3'),
        rtl: caption.rtl || false,
        translatable: caption.isTranslatable
      }
    })

    resolve({
      loadType: 'captions',
      data: captions
    })
  })
}

export default {
  startInnertube,
  stopInnertube,
  search,
  loadFrom,
  retrieveStream,
  loadCaptions
}