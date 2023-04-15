import utils from '../utils.js'

import vm from 'vm'
import { URLSearchParams } from 'url'

let playerInfo = {}

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

function startInnertube() {
  playerInfo.innertubeInterval = setIntervalNow(async () => {
    utils.debugLog('innertube', 5, { message: 'Fetching innertube data...' })
  
    const data = await utils.makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      utils.debugLog('innertube', 5, { message: `Failed to fetch innertube data: ${err.message}` })
    })
      
    const innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
    playerInfo.innertube = innertube.INNERTUBE_CONTEXT
    playerInfo.innertube.client.clientName = 'WEB',
    playerInfo.innertube.client.clientVersion = '2.20230316.00.00'
    playerInfo.innertube.client.originalUrl = 'https://www.youtube.com/'

    utils.debugLog('innertube', 5, { message: 'Fetched innertube data, fetching player.js...' })

    const player = await utils.makeRequest(`https://www.youtube.com${innertube.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER.jsUrl}`, { method: 'GET' }).catch((err) => {
      utils.debugLog('innertube', 5, { message: `Failed to fetch player js: ${err.message}` })
    })

    utils.debugLog('innertube', 5, { message: 'Fetched player.js, parsing...' })
  
    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]

    playerInfo.functions = []

    let functionName = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
    const sigFunction = 'function decipherFunction(a)' + player.split(`${functionName}=function(a)`)[1].split(')};')[0]
    const sigWrapper = player.split('this.audioTracks};')[1].split(')};var ')[1].split(')}};')[0]

    playerInfo.functions.push(`const ${sigWrapper})}};${sigFunction})};decipherFunction(sig)`)

    functionName = player.split('&&(b=a.get("n"))&&(b=')[1].split('(b)')[0]
    if (functionName.includes('[')) functionName = player.split(`${functionName.split('[')[0]}=[`)[1].split(']')[0]

    const ncodeFunction = player.split(`${functionName}=function`)[1].split('};')[0]
    playerInfo.functions.push(`const decipherNcode = function${ncodeFunction}};decipherNcode(ncode)`)
   
    utils.debugLog('innertube', 5, { message: 'Extracted signatureTimestamp, decipher signature and ncode functions.' })
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
    const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=[\w-]+&)?list=[\w-]+/
    const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/
  
    if (playlistRegex.test(url)) return 3
    else if (shortsRegex.test(url)) return 4
    else if (videoRegex.test(url)) return 2
    else return -1
  }
}

async function search(query, type, search) {
  return new Promise(async (resolve) => {

    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      utils.sleep(200)
    }

    switch (search ? 1 : checkURLType(query, type)) {
      case 1: {
        utils.debugLog('search', 4, { type: 1, sourceName: 'YouTube', query })

        const search = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/search`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            query,
          }
        })

        if (search.error) {
          utils.debugLog('search', 4, { type: 3, sourceName: 'YouTube', message: search.error.message })

          return resolve({ loadType: 'error', data: { message: search.error.message, severity: 'COMMON', cause: 'unknown' } })
        }
      
        let tracks = []
        let i = 0

        let videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
        if (videos[0].adSlotRenderer) videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[1].itemSectionRenderer.contents
        
        utils.forEach(videos, (item, index) => {
          item = item.videoRenderer

          if (item) {
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
              sourceName: type
            }

            tracks.push({
              encoded: utils.encodeTrack(infoObj),
              info: infoObj
            })
          }

          if (index == videos.length - 1) {
            if (tracks.length == 0) {
              utils.debugLog('search', 4, { type: 3, sourceName: 'YouTube', message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            utils.debugLog('search', 4, { type: 2, sourceName: 'YouTube', tracksLen: tracks.length, query })

            return resolve({
              loadType: 'search',
              data: tracks
            })
          }
        })

        break
      }
      case 2: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube', query })

        const video = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            videoId: /(?:\?v=)(\w+)/.exec(query)[1],
          }
        })

        if (video.playabilityStatus.status == 'ERROR') {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube', message: video.playabilityStatus.reason })
          
          return resolve({ loadType: 'error', data: { message: video.playabilityStatus.reason, severity: 'COMMON', cause: 'unknown' } })
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
          sourceName: type
        }

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube', track: infoObj, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: utils.encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          }
        })
      }
      case 3: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'playlist', sourceName: 'YouTube', query })

        const playlist = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false+`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            playlistId: /(?<=list=)[\w-]+/.exec(query)[0]
          }
        })

        if (!playlist.contents.twoColumnWatchNextResults.playlist) {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'error', sourceName: 'YouTube', message: 'Failed to load playlist.' })
        
          return resolve({
            loadType: 'error',
            data: {
              severity: 'COMMON',
              message: 'Failed to load playlist.',
              cause: 'unknown'
            }
          })
        }
      
        let tracks = []
        let i = 0

        utils.forEach(playlist.contents.twoColumnWatchNextResults.playlist.playlist.contents, (item, index) => {
          item = item.playlistPanelVideoRenderer

          if (item) {
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
              encoded: utils.encodeTrack(infoObj),
              info: infoObj,
              pluginInfo: {}
            })
          }

          if (index == playlist.contents.twoColumnWatchNextResults.playlist.playlist.contents.length - 1) {
            if (tracks.length == 0) {
              utils.debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'YouTube', message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

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
        })

        break
      }
      case 4: {
        utils.debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube Shorts', query })

        const short = await utils.makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            videoId: /shorts\/([a-zA-Z0-9_-]+)/.exec(query)[1]
          }
        })

        if (short.playabilityStatus.status == 'ERROR') {
          utils.debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube Shorts', message: short.playabilityStatus.reason })

          return resolve({ loadType: 'error', data: { message: short.playabilityStatus.reason, severity: 'COMMON', cause: 'unknown' } })
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

        utils.debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube Shorts', track: infoObj, query })

        return resolve({
          loadType: 'short',
          data: {
            encoded: utils.encodeTrack(infoObj),
            info: infoObj,
            pluginInfo: {}
          }
        })
      }

      default: {
        utils.debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: 'YouTube', message: 'No matches found.' })

        return resolve({ loadType: 'empty', data: {} })
      }
    }
  })
}

async function retrieveStream(identifier, type) {
  return new Promise(async (resolve) => {

    if (!playerInfo.innertube) while (1) {
      if (playerInfo.innertube) break

      utils.sleep(200)
    }

    const videos = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
      body: {
        context: playerInfo.innertube,
        videoId: identifier,
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: playerInfo.signatureTimestamp
          }
        }
      },
      method: 'POST'
    })

    if (videos.playabilityStatus.status != 'OK') {
      utils.debugLog('retrieveStream', 4, { type: 2, sourceName: 'YouTube', message: videos.playabilityStatus.reason })

      return resolve({ status: 1, exception: { severity: 'COMMON', message: videos.playabilityStatus.reason, cause: 'unknown' } })
    }

    let audio = videos.streamingData.adaptiveFormats[videos.streamingData.adaptiveFormats.length - 1]
    let url = audio.url

    if (audio.signatureCipher) {
      const args = new URLSearchParams(audio.signatureCipher)

      const components = new URL(decodeURIComponent(args.get('url')))
      components.searchParams.set('sig',  new vm.Script(playerInfo.functions[0]).runInNewContext({ sig: decodeURIComponent(args.get('s')) }))

      const n = components.searchParams.get('n')
      components.searchParams.set('n', new vm.Script(playerInfo.functions[1]).runInNewContext({ ncode: n }))

      console.log(components.toString())
      url = components.toString()
    } else {
      const components = new URL(url)

      const n = components.searchParams.get('n')
      components.searchParams.set('n', new vm.Script(playerInfo.functions[1]).runInNewContext({ ncode: n }))

      url = components.toString()
    }

    resolve({ status: 0, url })
  })
}

export default {
  startInnertube,
  stopInnertube,
  search,
  retrieveStream
}