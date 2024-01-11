import { URLSearchParams } from 'node:url'

import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack, randomLetters } from '../utils.js'

let playerInfo = {
  innertube: {
    thirdParty: {
      embedUrl: 'https://google.com'
    },
    client: {
      clientName: 'ANDROID',
      clientVersion: '17.29.34',
      androidSdkVersion: '34',
      screenDensityFloat: 1,
      screenHeightPoints: 1080,
      screenPixelDensity: 1,
      screenWidthPoints: 1920
    }
  },
  innertubeInterval: null,
  signatureTimestamp: null,
  functions: [],
  cache: {
    cpn: randomLetters(16),
    t: randomLetters(12)
  }
}

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

async function init() {
  playerInfo.innertubeInterval = setIntervalNow(async () => {
    debugLog('innertube', 5, { type: 1, message: 'Fetching deciphering functions...' })
 
    const { body: data } = await makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      debugLog('innertube', 5, { type: 2, message: `Failed to access YouTube website: ${err.message}` })
    })

    const { body: player } = await makeRequest(`https://www.youtube.com${/(?<=jsUrl":")[^"]+/.exec(data)[0]}`, { method: 'GET' }).catch((err) => {
      debugLog('innertube', 5, { type: 2, message: `Failed to fetch player.js: ${err.message}` })
    })

    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/.exec(player)[0]

    let functionName = player.match(/a.set\("alr","yes"\);c&&\(c=(.*?)\(/)[1]
    const decipherFunctionName = functionName

    const sigFunction = player.match(new RegExp(`${functionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}=function\\(a\\){(.*)\\)};`, 'g'))[0]

    functionName = player.match(/a=a\.split\(""\);(.*?)\./)[1]
    const sigWrapper = player.match(new RegExp(`var ${functionName}={(.*?)};`, 's'))[1]

    playerInfo.functions[0] = `const ${functionName}={${sigWrapper}};${sigFunction}${decipherFunctionName}(sig);`

    functionName = player.match(/&&\(b=a\.get\("n"\)\)&&\(b=(.*?)\(/)[1]

    if (functionName && functionName.includes('['))
      functionName = player.match(new RegExp(`${functionName.match(/([^[]*)\[/)[1]}=\\[(.*?)]`))[1]
    
    const ncodeFunction = player.match(new RegExp(`${functionName}=function(.*?)};`, 's'))[1]
    playerInfo.functions[1] = `const ${functionName} = function${ncodeFunction}};${functionName}(ncode)`

    debugLog('innertube', 5, { type: 1, message: 'Successfully fetched deciphering functions.' })
  }, 3600000)
}

function free() {
  clearInterval(playerInfo.innertubeInterval)
  playerInfo.innertubeInterval = null

  playerInfo.signatureTimestamp = null
  playerInfo.functions = []
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

async function search(query, type, shouldLog) {
  return new Promise(async (resolve) => {
    if (shouldLog) debugLog('search', 4, { type: 1, sourceName: 'YouTube', query })

    const { body: search } = await makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/search`, {
      method: 'POST',
      body: {
        context: playerInfo.innertube,
        query,
        params: 'EgIQAQ%3D%3D'
      }
    })

    if (search.error) {
      debugLog('search', 4, { type: 3, sourceName: 'YouTube', query, message: search.error.message })

      return resolve({ loadType: 'error', data: { message: search.error.message, severity: 'fault', cause: 'Unknown' } })
    }

    const tracks = []
    let i = 0

    const videos = search.contents.sectionListRenderer.contents[search.contents.sectionListRenderer.contents.length - 1].itemSectionRenderer.contents

    videos.forEach((video, index) => {
      video = video.compactVideoRenderer

      if (video) {
        const track = {
          identifier: video.videoId,
          isSeekable: true,
          author: video.longBylineText.runs[0].text,
          length: video.lengthText ? (parseInt(video.lengthText.runs[0].text.split(':')[0]) * 60 + parseInt(video.lengthText.runs[0].text.split(':')[1])) * 1000 : 0,
          isStream: video.lengthText ? false : true,
          position: i++,
          title: video.title.runs[0].text,
          uri: `https://www.youtube.com/watch?v=${video.videoId}`,
          artworkUrl: `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
          isrc: null,
          sourceName: type
        }

        tracks.push({
          encoded: encodeTrack(track),
          info: track
        })
      }

      if (index == videos.length - 1 || tracks.length == config.options.maxResultsLength - 1) {
        if (tracks.length == 0) {
          debugLog('search', 4, { type: 3, sourceName: 'YouTube', query, message: 'No matches found.' })
    
          return resolve({ loadType: 'empty', data: {} })
        }
    
        if (shouldLog) debugLog('search', 4, { type: 2, sourceName: 'YouTube', tracksLen: tracks.length, query })
    
        return resolve({ loadType: 'search', data: tracks })
      }
    })
  })
}

async function loadFrom(query, type) {
  return new Promise(async (resolve) => {
    switch (checkURLType(query, type)) {
      case 2: {
        debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube', query })
        
        const identifier = /v=([^&]+)/.exec(query)[1]

        const { body: video } = await makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
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
          debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube', query, message: video.playabilityStatus.reason || video.playabilityStatus.messages[0] })
          
          return resolve({ loadType: 'error', data: { message: video.playabilityStatus.reason || video.playabilityStatus.messages[0], severity: 'common', cause: 'Unknown' } })
        }

        const track = {
          identifier: video.videoDetails.videoId,
          isSeekable: true,
          author: video.videoDetails.author,
          length: parseInt(video.videoDetails.lengthSeconds) * 1000,
          isStream: video.videoDetails.isLive,
          position: 0,
          title: video.videoDetails.title,
          uri: `https://www.youtube.com/watch?v=${video.videoDetails.videoId}`,
          artworkUrl: `https://i.ytimg.com/vi/${video.videoDetails.videoId}/maxresdefault.jpg`,
          isrc: null,
          sourceName: type
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube', track, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }
      case 3: {
        debugLog('loadtracks', 4, { type: 1, loadType: 'playlist', sourceName: 'YouTube', query })

        const { body: playlist } = await makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
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

        if (!playlist.contents.singleColumnWatchNextResults.playlist) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'YouTube', query, message: 'Failed to load playlist.' })
        
          return resolve({ loadType: 'error', data: { message: 'Failed to load playlist.', severity: 'common', cause: 'Unknown' } })
        }
      
        const tracks = []
        let i = 0

        let playlistContent = playlist.contents.singleColumnWatchNextResults.playlist.playlist.contents

        if (playlistContent.length > config.options.maxAlbumPlaylistLength)
          playlistContent = playlistContent.slice(0, config.options.maxAlbumPlaylistLength)

        playlistContent.forEach((video) => {
          video = video.playlistPanelVideoRenderer

          if (video) {
            const track = {
              identifier: video.videoId,
              isSeekable: true,
              author: video.shortBylineText.runs ? video.shortBylineText.runs[0].text : 'Unknown author',
              length: video.lengthText ? (parseInt(video.lengthText.runs[0].text.split(':')[0]) * 60 + parseInt(video.lengthText.runs[0].text.split(':')[1])) * 1000 : 0,
              isStream: false,
              position: i++,
              title: video.title.runs[0].text,
              uri: `https://www.youtube.com/watch?v=${video.videoId}`,
              artworkUrl: `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
              isrc: null,
              sourceName: 'youtube'
            }

            tracks.push({
              encoded: encodeTrack(track),
              info: track,
              pluginInfo: {}
            })
          }
        })

        if (tracks.length == 0) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'YouTube', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'YouTube', playlistName: playlist.contents.singleColumnWatchNextResults.playlist.playlist.title })

        return resolve({
          loadType: 'playlist',
          data: {
            info: {
              name: playlist.contents.singleColumnWatchNextResults.playlist.playlist.title,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        })
      }
      case 4: {
        debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube Shorts', query })

        const { body: short } = await makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
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
          debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube Shorts', query, message: short.playabilityStatus.reason || short.playabilityStatus.messages[0] })

          return resolve({ loadType: 'error', data: { message: short.playabilityStatus.reason || short.playabilityStatus.messages[0], severity: 'common', cause: 'Unknown' } })
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

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube Shorts', track, query })

        return resolve({
          loadType: 'short',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }

      default: {
        debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: 'YouTube', query, message: 'No matches found.' })

        return resolve({ loadType: 'empty', data: {} })
      }
    }
  })
}

async function retrieveStream(identifier, type, title) {
  return new Promise(async (resolve) => {
    const { body: videos } = await makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
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
      headers: {
        'User-Agent': 'com.google.android.youtube/17.29.34 (Linux; U; Android 13) gzip'
      },
      method: 'POST'
    })

    if (videos.playabilityStatus.status != 'OK') {
      debugLog('retrieveStream', 4, { type: 2, sourceName: 'YouTube', query: title, message: videos.playabilityStatus.reason })

      return resolve({ exception: { message: videos.playabilityStatus.reason, severity: 'common', cause: 'Unknown' } })
    }

    let itag = null
    switch (config.audio.quality) {
      case 'high': itag = 251; break
      case 'medium': itag = 250; break
      case 'low': itag = 249; break
      case 'lowest': itag = 599; break
      default: itag = 251; break
    }

    const audio = videos.streamingData.adaptiveFormats.find((format) => format.itag == itag) || videos.streamingData.adaptiveFormats.find((format) => format.mimeType.startsWith('audio/'))

    const args = new URLSearchParams(audio.url || audio.signatureCipher || audio.cipher)
    let url = decodeURIComponent(audio.url || args.get('url'))

    url += '&ratebypass=yes&range=0-'

    if (audio.signatureCipher || audio.cipher)
      url += `&${args.get('sp')}=${eval(`const sig = ${args.get('s')};` + playerInfo.functions[0])}`

    if (args.get('n'))
      url += `&${args.get('n')}=${eval(`const ncode = ${args.get('s')};` + playerInfo.functions[1])}`

    resolve({ url, protocol: 'https', format: audio.mimeType == 'audio/webm; codecs="opus"' ? 'webm/opus' : 'arbitrary' })
  })
}

async function loadLyrics(decodedTrack, language) {
  return new Promise(async (resolve) => {
    const { body: video } = await makeRequest(`https://${decodedTrack.sourceName == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
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
      debugLog('loadlyrics', 4, { type: 2, sourceName: 'YouTube', track: { title: decodedTrack.title, author: decodedTrack.author }, message: video.playabilityStatus.reason })

      return resolve({ loadType: 'error', data: { message: video.playabilityStatus.reason, severity: 'common', cause: 'Unknown' } })
    }

    const selectedCaption = video.captions.playerCaptionsTracklistRenderer.captionTracks.find((caption) => {
      return caption.languageCode == language
    })

    if (selectedCaption) {
      const { body: captionData } = await makeRequest(selectedCaption.baseUrl.replace('&fmt=srv3', '&fmt=json3'), { method: 'GET' }).catch((err) => {
        debugLog('loadlyrics', 4, { type: 2, sourceName: 'YouTube', track: { title: decodedTrack.title, author: decodedTrack.author }, message: err.message })

        return resolve({ loadType: 'error', data: { message: err.message, severity: 'common', cause: 'Unknown' } })
      })

      const captionEvents = captionData.events.map((event) => {
        return {
          startTime: event.tStartMs,
          endTime: event.tStartMs + event.dDurationMs,
          text: event.segs ? event.segs.map((seg) => seg.utf8).join('') : null
        }
      })

      resolve({
        loadType: 'lyricsSingle',
        data: {
          name: selectedCaption.languageCode,
          synced: true,
          data: captionEvents,
          rtl: !!selectedCaption.rtl
        }
      })
    } else {
      const captions = []
      let i = 0

      if (!video.captions)
        return resolve(null)

      video.captions.playerCaptionsTracklistRenderer.captionTracks.forEach(async (caption) => {
        const { body: captionData } = await makeRequest(caption.baseUrl.replace('&fmt=srv3', '&fmt=json3'), { method: 'GET' }).catch((err) => {
          debugLog('loadlyrics', 4, { type: 2, sourceName: 'YouTube', track: { title: decodedTrack.title, author: decodedTrack.author }, message: err.message })

          return resolve({ loadType: 'error', data: { message: err.message, severity: 'common', cause: 'Unknown' } })
        })

        const captionEvents = captionData.events.map((event) => {
          return {
            startTime: event.tStartMs,
            endTime: event.tStartMs + event.dDurationMs,
            text: event.segs ? event.segs.map((seg) => seg.utf8).join('') : null
          }
        })

        captions.push({
          name: caption.languageCode,
          synced: true,
          data: captionEvents,
          rtl: !!caption.rtl
        })

        if (i == video.captions.playerCaptionsTracklistRenderer.captionTracks.length - 1) {
          if (captions.length == 0) {
            debugLog('loadlyrics', 4, { type: 3, sourceName: 'YouTube', track: { title: decodedTrack.title, author: decodedTrack.author }, message: 'No captions found.' })

            return resolve(null)
          }

          debugLog('loadlyrics', 4, { type: 2, sourceName: 'YouTube', track: { title: decodedTrack.title, author: decodedTrack.author } })

          return resolve({
            loadType: 'lyricsMultiple',
            data: captions
          })
        }
      })
    }
  })
}

export default {
  init,
  free,
  search,
  loadFrom,
  retrieveStream,
  loadLyrics
}