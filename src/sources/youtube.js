import utils from '../utils.js'

let playerInfo = {}

function setIntervalNow(func, interval) {
  func()
  return setInterval(func, interval)
}

function startInnertube() {
  playerInfo.innertubeInterval = setIntervalNow(async () => {
    console.log('[NodeLink:sources]: Fetching YouTube embed page...')
  
    const data = await utils.makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink:sources]: Failed to fetch innertube data: ${err.message}`)
    })
      
    const innertube = JSON.parse('{' + data.split('ytcfg.set({')[1].split('});')[0] + '}')
    playerInfo.innertube = innertube.INNERTUBE_CONTEXT
    playerInfo.innertube.client.clientName = 'WEB',
    playerInfo.innertube.client.clientVersion = '2.20230316.00.00'
    playerInfo.innertube.client.originalUrl = 'https://www.youtube.com/'

    console.log('[NodeLink:sources]: Sucessfully extracted InnerTube Context. Fetching player.js...')

    const player = await utils.makeRequest(`https://www.youtube.com${innertube.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER.jsUrl}`, { method: 'GET' }).catch((err) => {
      console.log(`[NodeLink:sources]: Failed to fetch player js: ${err.message}`)
    })

    console.log('[NodeLink:sources]: Fetch player.js from YouTube.')
  
    playerInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/gm.exec(player)[0]
  
    let dFunctionHighLevel = player.split('a.set("alr","yes");c&&(c=')[1].split('(decodeURIC')[0]
    dFunctionHighLevel = ('function decipher(a)' + player.split(`${dFunctionHighLevel}=function(a)`)[1].split(')};')[0] + ')};')
    let decipherLowLevel = player.split('this.audioTracks};')[1].split(')};var ')[1].split(')}};')[0]

    playerInfo.decipherEval = `const ${decipherLowLevel})}};${dFunctionHighLevel}decipher('NODELINK_DECIPHER_URL');`

    console.log('[NodeLink:sources]: Successfully processed information for next loadtracks and play.')
  }, 120000)
}

function stopInnertube() {
  clearInterval(playerInfo.innertubeInterval)
}

function checkURLType(url, type) {
  if (type == 'ytmusic') {
    const videoRegex = /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/
    const playlistRegex = /^https?:\/\/music\.youtube\.com\/playlist\?list=[\w-]+/
    
    if (videoRegex.test(url)) return 2
    else if (playlistRegex.test(url)) return 3
    else return -1
  } else {
    const videoRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/
    const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/
    const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/
  
    if (videoRegex.test(url)) return 2
    else if (playlistRegex.test(url)) return 3
    else if (shortsRegex.test(url)) return 4
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
        console.log(`[NodeLink:sources]: Searching track on YouTube: ${query}`)

        const search = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/search`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            query,
          }
        })

        if (search.error) {
          console.log(`[NodeLink:sources]: Failed to search for "${query}": ${search.error.message}`)

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
              console.log(`[NodeLink:sources]: No matches found for "${query}".`)
              console.log(videos)

              return resolve({ loadType: 'empty', data: {} })
            }

            return resolve({
              loadType: 'search',
              data: tracks
            })
          }
        })

        break
      }
      case 2: {
        console.log(`[NodeLink:sources]: Loading track from YouTube: ${query}`)

        const video = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            videoId: /(?:\?v=)(\w+)/.exec(query)[1],
          }
        })

        if (video.playabilityStatus.status == 'ERROR') {
          console.log(`[NodeLink:sources]: Failed to load track: ${video.playabilityStatus.reason}`)
          
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
        console.log(`[NodeLink:sources]: Loading playlist from YouTube: ${query}`)

        const playlist = await utils.makeRequest(`https://${type == 'ytmusic' ? 'music' : 'www'}.youtube.com/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false+`, {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            playlistId: /(?<=list=)[\w-]+/.exec(query)[0]
          }
        })

        if (!playlist.contents.twoColumnWatchNextResults.playlist) {
          console.log(`[NodeLink:sources]: Failed to load playlist.`)
        
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
              console.log(`[NodeLink:sources]: No matches found for "${query}".`)

              return resolve({ loadType: 'empty', data: {} })
            }

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
        console.log(`[NodeLink:sources]: Loading track from YouTube Shorts: ${query}`)

        const short = await utils.makeRequest('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            videoId: /shorts\/([a-zA-Z0-9_-]+)/.exec(query)[1]
          }
        })

        if (short.playabilityStatus.status == 'ERROR') {
          console.log(`[NodeLink:sources]: Failed to load track: ${short.playabilityStatus.reason}`)

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
        console.log(`[NodeLink:sources]: No matches found for "${query}".`)

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
      console.log('[NodeLink:sources]: The track is not playable, this is not a NodeLink issue.')

      return resolve({ status: 1, exception: { severity: 'COMMON', message: 'This video is marked as not playable.', cause: 'unknown' } })
    }

    const audio = videos.streamingData.adaptiveFormats[videos.streamingData.adaptiveFormats.length - 1]
    let url = audio.url

    if (audio.signatureCipher) {
      url = audio.signatureCipher.split('&')
    
      const signature = eval(playerInfo.decipherEval.replace('NODELINK_DECIPHER_URL', decodeURIComponent(url[0].replace('s=', ''))))

      url = `${decodeURIComponent(url[2].replace('url=', ''))}&${url[1].replace('sp=', '')}=${signature}&sts=${playerInfo.signatureTimestamp}`

      console.log('[NodeLink:sources]: Started playing track protected by cipher signature')
    } else {
      console.log('[NodeLink:sources]: Started playing track with no cipher signature')
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