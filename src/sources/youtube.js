import utils from '../utils.js'

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

function checkURLType(url) {
  const videoRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+/;
  const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/;
  const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/;
  
  if (videoRegex.test(url)) return 2
  else if (playlistRegex.test(url)) return 3
  else if (shortsRegex.test(url)) return 4
  else return -1
}

async function search(query, type) {
  return new Promise(async (resolve) => {
    switch (type) {
      case 1: {
        const search = await utils.nodelink_makeRequest('https://www.youtube.com/youtubei/v1/search', {
          method: 'POST',
          body: {
            context: playerInfo.innertube,
            query,
          }
        })

        if (search.error) {
          console.log(`[NodeLink]: Failed to search for "${query}": ${search.error.message}`)

          return resolve({
            loadType: 'LOAD_FAILED',
            playlistInfo: null,
            tracks: [],
            exception: {
              severity: 'COMMON',
              message: search.error.message
            }
          })
        }
      
        let tracks = []
        let i = 0

        let videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
        if (videos[0].adSlotRenderer) videos = search.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[1].itemSectionRenderer.contents
        
        videos.forEach((item) => {
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

        return resolve({
          loadType: tracks.length == 0 ? 'NO_MATCHES' : 'SEARCH_RESULT',
          playlistInfo: null,
          tracks,
          exception: null
        })
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
          
          return resolve({
            loadType: 'LOAD_FAILED',
            playlistInfo: null,
            tracks: [],
            exception: {
              severity: 'COMMON',
              message: video.playabilityStatus.reason
            }
          })
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

        return resolve({
          loadType: 'TRACK_LOADED',
          playlistInfo: null,
          tracks: [{
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          }],
          exception: null
        })
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
        
          return resolve({
            loadType: 'LOAD_FAILED',
            playlistInfo: null,
            tracks: [],
            exception: {
              severity: 'COMMON',
              message: 'Failed to load playlist.'
            }
          })
        }
      
        let tracks = []
        let i = 0

         playlist.contents.twoColumnWatchNextResults.playlist.playlist.contents.forEach((item) => {
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
              encoded: utils.nodelink_encodeTrack(infoObj),
              info: infoObj
            })
          }
        })

        return resolve({
          loadType: 'PLAYLIST_LOADED',
          playlistInfo: {
            name: playlist.contents.twoColumnWatchNextResults.playlist.playlist.title,
            selectedTrack: 0
          },
          tracks,
          exception: null
        })
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

          return resolve({
            loadType: 'LOAD_FAILED',
            playlistInfo: null,
            tracks: [],
            exception: {
              severity: 'COMMON',
              message: short.playabilityStatus.reason
            }
          })
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
          loadType: 'SHORT_LOADED',
          playlistInfo: null,
          tracks: [{
            encoded: utils.nodelink_encodeTrack(infoObj),
            info: infoObj
          }],
          exception: null
        })
      }
    }
  })
}

async function retrieveStream(identifier) {
  return new Promise(async (resolve) => {
    const videos = await utils.nodelink_makeRequest(`https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
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
      console.log('[NodeLink]: The track is not playable, this is not a NodeLink issue.')

      return resolve({ status: 1, exception: { severity: 'COMMON', message: 'This video is marked as not playable.' } })
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

    resolve({ status: 0, url })
  })
}

export default {
  startInnertube,
  stopInnertube,
  checkURLType,
  search,
  retrieveStream
}