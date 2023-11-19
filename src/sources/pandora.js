import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack, http1makeRequest } from '../utils.js'
import searchWithDefault from './default.js'

let csrfToken = null
let authToken = null

async function init() {
  debugLog('pandora', 5, { type: 1, message: 'Setting Pandora auth and CSRF token.' })

  const csfr = await makeRequest('https://www.pandora.com', { method: 'GET', cookiesOnly: true })

  if (!csfr[1]) return debugLog('pandora', 5, { type: 2, message: 'Failed to set CSRF token from Pandora.' })

  csrfToken = { raw: csfr[1], parsed: /csrftoken=([a-f0-9]{16});/.exec(csfr[1])[1] }

  const token = await makeRequest('https://www.pandora.com/api/v1/auth/anonymousLogin', {
    headers: {
      'Cookie': csrfToken.raw,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'X-CsrfToken': csrfToken.parsed
    },
    method: 'POST'
  })

  if (token.errorCode == 0) return debugLog('pandora', 5, { type: 2, message: 'Failed to set auth token from Pandora.' })

  authToken = token.authToken

  debugLog('pandora', 5, { type: 1, message: 'Successfully set Pandora auth and CSRF token.' })
}

async function search(query) {
  return new Promise(async (resolve) => {
    debugLog('search', 4, { type: 1, sourceName: 'Pandora', query })

    const body = {
      query,
      types: ['TR'],
      listener: null,
      start: 0,
      count: config.options.maxResultsLength,
      annotate: true,
      searchTime: 0,
      annotationRecipe: 'CLASS_OF_2019'
    }
   
    const data = await makeRequest('https://www.pandora.com/api/v3/sod/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Content-Length': JSON.stringify(body).length
      },
      body,
      disableBodyCompression: true
    })

    if (data.results.length == 0)
      return resolve({ loadType: 'empty', data: {} })

    const tracks = []
    let index = 0
    let shouldStop = false

    let annotationKeys = Object.keys(data.annotations)

    if (annotationKeys.length > config.options.maxResultsLength)
      annotationKeys = annotationKeys.slice(0, config.options.maxResultsLength)

    annotationKeys.forEach(async (key) => {
      if (data.annotations[key].type == 'TR') {
        const search = await searchWithDefault(`${data.annotations[key].name} ${data.annotations[key].artistName}`)

        if (search.loadType == 'search') {
          const track = {
            identifier: search.data[0].info.identifier,
            isSeekable: true,
            author: data.annotations[key].artistName,
            length: search.data[0].info.length,
            isStream: false,
            position: index,
            title: data.annotations[key].name,
            uri: `https://www.pandora.com${data.annotations[key].shareableUrlPath}`,
            artworkUrl: `https://content-images.p-cdn.com/${data.annotations[key].icon.artUrl}`,
            isrc: data.annotations[key].isrc,
            sourceName: 'pandora'
          }

          tracks.push({
            encoded: encodeTrack(track),
            info: track,
            playlistInfo: {}
          })
        }
      }

      if (index == data.results.length - 1) {
        const new_tracks = []
        annotationKeys.forEach((key2, index2) => {
          tracks.forEach((track3, index3) => {
            if (shouldStop) return;

            if (track3.info.title == data.annotations[key2].name && track3.info.author == data.annotations[key2].artistName) {
              track3.info.position = index2
              new_tracks.push(track3)
            }

            if ((index2 == annotationKeys.length - 1) && (index3 == tracks.length - 1)) {
              debugLog('search', 4, { type: 2, sourceName: 'Pandora', tracksLen: new_tracks.length, query })

              shouldStop = true

              resolve({
                loadType: 'search',
                data: new_tracks
              })
            }
          })
        })
      }
    })
  })
}

async function loadFrom(query) {
  return new Promise(async (resolve) => {
    const type = /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.exec(query)

    debugLog('loadtracks', 4, { type: 1, loadType: type[2], sourceName: 'Pandora', query })

    if (!type)
      return resolve({ loadType: 'error', data: { message: 'Not a valid pandora URL.', severity: 'common', cause: 'Invalid URL' } })

    if (!csrfToken)
      return resolve({ loadType: 'error', data: { message: 'Pandora not available in current country.', severity: 'common', cause: 'Pandora availability' } })

    let lastPart = query.split('/')
    lastPart = lastPart[lastPart.length - 1]

    switch (type[2]) {
      case 'artist': {
        const trackData = await http1makeRequest('https://www.pandora.com/api/v4/catalog/annotateObjectsSimple', {
          body: {
            pandoraIds: [ lastPart ],
          },
          headers: {
            'Cookie': csrfToken.raw,
            'X-CsrfToken': csrfToken.parsed,
            'X-AuthToken': authToken,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          disableBodyCompression: true
        })

        const keysTrackData = Object.keys(trackData)

        let trackType = null
        switch (trackData[keysTrackData[0]] ? trackData[keysTrackData[0]].type : 'unknown') {
          case 'TR': trackType = 'track'; break
          case 'AL': trackType = 'album'; break
          case 'AR': trackType = 'artist'; break
          default: trackType = 'unknown'; break
        }

        if (keysTrackData.length == 0) {
          debugLog('loadtracks', 4, { type: 3, loadType: trackType, sourceName: 'Pandora', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }

        if (trackData.message) {
          debugLog('loadtracks', 4, { type: 3, loadType: trackType, sourceName: 'Pandora', query, message: trackData.message })
      
          return resolve({ loadType: 'error', data: { message: trackData.message, severity: 'common', cause: 'Unknown' } })
        }

        const trackId = trackData[keysTrackData[0]].pandoraId

        switch (trackData[keysTrackData].type) {
          case 'TR': {
            const item = trackData[keysTrackData]

            const search = await searchWithDefault(`${item.name} ${item.artistName}`)

            if (search.loadType != 'search')
              return resolve(search)
    
            const track = {
              identifier: search.data[0].info.identifier,
              isSeekable: true,
              author: item.artistName,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: item.name,
              uri: `https://www.pandora.com${item.shareableUrlPath}`,
              artworkUrl: `https://content-images.p-cdn.com/${item.icon.artUrl}`,
              isrc: item.isrc,
              sourceName: 'pandora'
            }

            debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Pandora', track, query })
    
            resolve({
              loadType: 'track',
              data: {
                encoded: encodeTrack(track),
                info: track,
                playlistInfo: {}
              }
            })

            break
          }
          case 'AL': {
            const data = await http1makeRequest('https://www.pandora.com/api/v4/catalog/getDetails', {
              body: {
                pandoraId: trackId
              },
              headers: {
                'Cookie': csrfToken.raw,
                'X-CsrfToken': csrfToken.parsed,
                'X-AuthToken': authToken
              },
              method: 'POST',
              disableBodyCompression: true
            })
  
            if (data.errors || typeof data != 'object') {
              const errorMessage = typeof data != 'object' ? 'Unknown error' : data.errors.map((err) => `${err.message} (${err.extensions.code})`).join('; ')
  
              debugLog('loadtracks', 4, { type: 3, loadType: 'album', sourceName: 'Pandora', query, message: errorMessage })
          
              return resolve({ loadType: 'error', data: { message: errorMessage, severity: 'common', cause: 'Unknown' } })
            }
  
            const tracks = []
            let index = 0
            let shouldStop = false

            let trackKeys = Object.keys(data.annotations)
  
            if (trackKeys.length > config.options.maxAlbumPlaylistLength)
              trackKeys = trackKeys.slice(0, config.options.maxAlbumPlaylistLength)
  
            trackKeys.forEach(async (key, i) => {
              const search = await searchWithDefault(`${data.annotations[key].name} ${data.annotations[key].artistName}`)
        
              if (search.loadType == 'search') {
                const track = {
                  identifier: search.data[0].info.identifier,
                  isSeekable: true,
                  author: data.annotations[key].artistName,
                  length: search.data[0].info.length,
                  isStream: false,
                  position: 0,
                  title: data.annotations[key].name,
                  uri: `https://www.pandora.com${data.annotations[key].shareableUrlPath}`,
                  artworkUrl: `https://content-images.p-cdn.com/${data.annotations[key].icon.artUrl}`,
                  isrc: data.annotations[key].isrc,
                  sourceName: 'pandora'
                }
            
                tracks.push({
                  encoded: null,
                  info: track,
                  playlistInfo: {}
                })
              }
        
              if (index == trackKeys.length - 1) {
                if (tracks.length == 0) {
                  debugLog('loadtracks', 4, { type: 3, loadType: 'album', sourceName: 'Pandora', query, message: 'No matches found.' })
  
                  return resolve({ loadType: 'empty', data: {} })
                }

                const new_tracks = []
                trackKeys.forEach((key2, index2) => {
                  tracks.forEach((track3, index3) => {
                    if (shouldStop) return;
  
                    if (track3.info.title == data.annotations[key2].name && track3.info.author == data.annotations[key2].artistName) {
                      track3.info.position = index2
                      track3.encoded = encodeTrack(track3.info)
  
                      new_tracks.push(track3)
                    }
        
                    if ((index2 == trackKeys.length - 1) && (index3 == tracks.length - 1)) {
                      shouldStop = true
  
                      debugLog('loadtracks', 4, { type: 2, loadType: 'album', sourceName: 'Pandora', playlistName: trackData[trackId].name })
  
                      resolve({
                        loadType: 'album',
                        data: {
                          info: {
                            name: trackData[trackId].name,
                            selectedTrack: 0,
                          },
                          pluginInfo: {},
                          tracks: new_tracks,
                        }
                      })
                    }
                  })
                })
              }

              index++
            })

            break
          }
          case 'AR': {
            const data = await http1makeRequest('https://www.pandora.com/api/v1/graphql/graphql', {
              body: {
                operationName: 'GetArtistDetailsWithCuratorsWeb',
                query: 'query GetArtistDetailsWithCuratorsWeb($pandoraId: String!) {\n  entity(id: $pandoraId) {\n    ... on Artist {\n      id\n      type\n      urlPath\n      name\n      trackCount\n      albumCount\n      bio\n      canSeedStation\n      stationListenerCount\n      albumCount\n      artistTracksId\n      art {\n        ...ArtFragment\n        __typename\n      }\n      isMegastar\n      headerArt {\n        ...ArtFragment\n        __typename\n      }\n      topTracksWithCollaborations {\n        ...TrackFragment\n        __typename\n      }\n      artistPlay {\n        id\n        __typename\n      }\n      events {\n        externalId\n        __typename\n      }\n      latestReleaseWithCollaborations {\n        ...AlbumFragment\n        __typename\n      }\n      topAlbumsWithCollaborations {\n        ...AlbumFragment\n        __typename\n      }\n      similarArtists {\n        id\n        name\n        art {\n          ...ArtFragment\n          __typename\n        }\n        urlPath\n        __typename\n      }\n      twitterHandle\n      twitterUrl\n      allArtistAlbums {\n        totalItems\n        __typename\n      }\n      curator {\n        ...CurationFragment\n        __typename\n      }\n      featured(types: [PL, AR, AL, TR, SF, PC, PE]) {\n        ... on Playlist {\n          ...PlaylistFragment\n          __typename\n        }\n        ... on StationFactory {\n          ...StationFactoryFragment\n          __typename\n        }\n        ... on Artist {\n          ...ArtistFragment\n          __typename\n        }\n        ... on Album {\n          ...AlbumFragment\n          __typename\n        }\n        ... on Track {\n          ...TrackFragment\n          __typename\n        }\n        ... on Podcast {\n          ...PodcastFragment\n          __typename\n        }\n        ... on PodcastEpisode {\n          ...PodcastEpisodeFragment\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment ArtFragment on Art {\n  artId\n  dominantColor\n  artUrl: url(size: WIDTH_500)\n}\n\nfragment TrackFragment on Track {\n  pandoraId: id\n  type\n  name\n  sortableName\n  duration\n  trackNumber\n  explicitness\n  hasRadio: canSeedStation\n  shareableUrlPath: urlPath\n  modificationtime: dateModified\n  slugPlusPandoraId: slugPlusId\n  artistId: artist {\n    pandoraId: id\n    __typename\n  }\n  artistName: artist {\n    name\n    __typename\n  }\n  albumId: album {\n    pandoraId: id\n    __typename\n  }\n  albumName: album {\n    name\n    __typename\n  }\n  album {\n    urlPath\n    __typename\n  }\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n  rightsInfo: rights {\n    ...RightsFragment\n    __typename\n  }\n}\n\nfragment AlbumFragment on Album {\n  pandoraId: id\n  type\n  name\n  sortableName\n  duration\n  trackCount\n  releaseDate\n  explicitness\n  isCompilation\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  slugPlusPandoraId: slugPlusId\n  artistId: artist {\n    pandoraId: id\n    __typename\n  }\n  artistName: artist {\n    name\n    __typename\n  }\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n  artist {\n    url\n    __typename\n  }\n  rightsInfo: rights {\n    ...RightsFragment\n    __typename\n  }\n}\n\nfragment CurationFragment on Curator {\n  curatedStations {\n    items {\n      ...StationFactoryFragment\n      __typename\n    }\n    __typename\n  }\n  playlists {\n    items {\n      ...PlaylistFragment\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment PlaylistFragment on Playlist {\n  pandoraId: id\n  type\n  name\n  sortableName\n  description\n  duration\n  totalTracks\n  version\n  isEditable\n  linkedId\n  linkedType: origin\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  unlocked: isUnlocked\n  autogenForListener: isOfAnyOrigin(origins: [PERSONALIZED, SHARED])\n  hasVoiceTrack: includesAny(types: [AM])\n  listenerIdInfo: owner {\n    listenerPandoraId: id\n    displayName\n    isMe\n    __typename\n  }\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n}\n\nfragment StationFactoryFragment on StationFactory {\n  pandoraId: id\n  type\n  name\n  sortableName\n  hasTakeoverModes\n  isHosted\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  seedId: seed {\n    pandoraId: id\n    __typename\n  }\n  seedType: seed {\n    type\n    __typename\n  }\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n  listenerCount\n}\n\nfragment ArtistFragment on Artist {\n  pandoraId: id\n  type\n  name\n  sortableName\n  trackCount\n  collaboration: isCollaboration\n  megastar: isMegastar\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  hasRadio: canSeedStation\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n}\n\nfragment PodcastFragment on Podcast {\n  pandoraId: id\n  type\n  name\n  sortableName\n  publisherName\n  ordering: releaseType\n  episodeCount: totalEpisodeCount\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n  rightsInfo: rights {\n    ...RightsFragment\n    __typename\n  }\n}\n\nfragment PodcastEpisodeFragment on PodcastEpisode {\n  pandoraId: id\n  type\n  name\n  sortableName\n  duration\n  releaseDate\n  explicitness\n  shareableUrlPath: urlPath\n  modificationTime: dateModified\n  podcastId: podcast {\n    pandoraId: id\n    __typename\n  }\n  programName: podcast {\n    name\n    __typename\n  }\n  elapsedTime: playbackProgress {\n    elapsedTime\n    __typename\n  }\n  icon: art {\n    ...ArtFragment\n    __typename\n  }\n  rightsInfo: rights {\n    ...RightsFragment\n    __typename\n  }\n}\n\nfragment RightsFragment on Rights {\n  expirationTime\n  hasInteractive\n  hasRadioRights\n  hasOffline\n}\n',
                variables: {
                  pandoraId: trackId
                }
              },
              headers: {
                'Cookie': csrfToken.raw,
                'X-CsrfToken': csrfToken.parsed,
                'X-AuthToken': authToken
              },
              method: 'POST',
              disableBodyCompression: true
            })
  
            if (data.errors || typeof data != 'object') {
              const errorMessage = typeof data != 'object' ? 'Unknown error' : data.errors.map((err) => `${err.message} (${err.extensions.code})`).join('; ')
  
              debugLog('loadtracks', 4, { type: 3, loadType: 'artist', sourceName: 'Pandora', query, message: errorMessage })
          
              return resolve({ loadType: 'error', data: { message: errorMessage, severity: 'common', cause: 'Unknown' } })
            }
  
            const tracks = []
            let index = 0
            let shouldStop = false

            let topTracks = data.data.entity.topTracksWithCollaborations
  
            if (topTracks.length > config.options.maxAlbumPlaylistLength)
              topTracks = topTracks.slice(0, config.options.maxAlbumPlaylistLength)
            
            topTracks.forEach(async (pTrack) => {
              const search = await searchWithDefault(`${pTrack.name} ${pTrack.artistName.name}`)
        
              if (search.loadType == 'search') {
                const track = {
                  identifier: search.data[0].info.identifier,
                  isSeekable: true,
                  author: pTrack.artistName.name,
                  length: search.data[0].info.length,
                  isStream: false,
                  position: 0,
                  title: pTrack.name,
                  uri: `https://www.pandora.com${pTrack.shareableUrlPath}`,
                  artworkUrl: pTrack.icon.artUrl,
                  isrc: null,
                  sourceName: 'pandora'
                }
          
                tracks.push({
                  encoded: null,
                  info: track,
                  playlistInfo: {}
                })
              }
        
              if (index == topTracks.length - 1) {
                if (tracks.length == 0) {
                  debugLog('loadtracks', 4, { type: 3, loadType: 'artist', sourceName: 'Pandora', query, message: 'No matches found.' })

                  return resolve({ loadType: 'empty', data: {} })
                }

                const new_tracks = []
                topTracks.forEach((track2, index2) => {
                  tracks.forEach((track3, index3) => {
                    if (shouldStop) return;
  
                    if (track3.info.title == track2.name && track3.info.author == track2.artistName.name) {
                      track3.info.position = index2
                      track3.encoded = encodeTrack(track3.info)
    
                      new_tracks.push(track3)
                    }
        
                    if ((index2 == topTracks.length - 1) && (index3 == tracks.length - 1)) {
                      shouldStop = true
  
                      debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Pandora', playlistName: data.data.entity.name })
  
                      resolve({
                        loadType: 'artist',
                        data: {
                          info: {
                            name: trackData[trackId].name,
                            artworkUrl: `https://content-images.p-cdn.com/${trackData[trackId].icon.artUrl}`,
                          },
                          pluginInfo: {},
                          tracks: new_tracks,
                        }
                      })
                    }
                  })
                })
              }

              index++
            })

            break
          }
        }

        break
      }
      case 'playlist': {
        const body = {
          request: {
            pandoraId: lastPart,
            playlistVersion: 0,
            offset: 0,
            limit: config.options.maxAlbumPlaylistLength,
            annotationLimit: config.options.maxAlbumPlaylistLength,
            allowedTypes: ['TR', 'AM'],
            bypassPrivacyRules: true
          }
        }

        const data = await makeRequest('https://www.pandora.com/api/v7/playlists/getTracks', {
          method: 'POST',
          headers: {
            'Cookie': csrfToken.raw,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Content-Length': JSON.stringify(body).length,
            'X-CsrfToken': csrfToken.parsed,
            'X-AuthToken': authToken
          },
          body,
          disableBodyCompression: true
        })
    
        const tracks = []
        let index = 0
        let shouldStop = false

        let keys = Object.keys(data.annotations).filter((key) => key.indexOf('TR:') != -1)

        if (keys.length > config.options.maxAlbumPlaylistLength)
          keys = keys.slice(0, config.options.maxAlbumPlaylistLength)

        keys.forEach(async (key) => {
          const search = await searchWithDefault(`${data.annotations[key].name} ${data.annotations[key].artistName}`)
    
          if (search.loadType == 'search') {
            const track = {
              identifier: search.data[0].info.identifier,
              isSeekable: data.annotations[key].visible,
              author: data.annotations[key].artistName,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: data.annotations[key].name,
              uri: search.data[0].info.uri,
              artworkUrl: `https://content-images.p-cdn.com/${data.annotations[key].icon.artUrl}`,
              isrc: data.annotations[key].isrc,
              sourceName: 'pandora'
            }
      
            tracks.push({
              encoded: encodeTrack(track),
              info: track,
              playlistInfo: {}
            })
          }
    
          if (index == keys.length - 1) {
            if (tracks.length == 0) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: 'Pandora', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            const new_tracks = []
            keys.forEach((key2, index2) => {
              tracks.forEach((track3, index3) => {
                if (shouldStop) return;

                if (track3.info.title == data.annotations[key2].name && track3.info.author == data.annotations[key2].artistName) {
                  track3.info.position = index2
                  new_tracks.push(track3)
                }
    
                if ((index2 == keys.length - 1) && (index3 == tracks.length - 1)) {
                  shouldStop = true

                  debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Pandora', playlistName: data.name })

                  resolve({
                    loadType: 'playlist',
                    data: {
                      info: {
                        name: data.name,
                        selectedTrack: 0,
                      },
                      pluginInfo: {},
                      tracks: new_tracks,
                    }
                  })
                }
              })
            })
          }

          index++
        })

        break
      }
      case 'station': {
        const stationData = await http1makeRequest('https://www.pandora.com/api/v1/station/getStationDetails', {
          body: {
            stationId: lastPart
          },
          headers: {
            'Cookie': csrfToken.raw,
            'X-CsrfToken': csrfToken.parsed,
            'X-AuthToken': authToken
          },
          method: 'POST',
          disableBodyCompression: true
        })

        if (stationData.length == 0) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'station', sourceName: 'Pandora', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }

        if (stationData.message) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'station', sourceName: 'Pandora', query, message: stationData.message })
      
          return resolve({ loadType: 'error', data: { message: stationData.message, severity: 'common', cause: 'Unknown' } })
        }

        const tracks = []
        let index = 0
        let shouldStop = false

        let seeds = stationData.seeds

        if (seeds.length > config.options.maxAlbumPlaylistLength)
          seeds = seeds.slice(0, config.options.maxAlbumPlaylistLength)

        seeds.forEach(async (seed) => {
          const search = await searchWithDefault(`${seed.song.songTitle} ${seed.song.artistSummary}`)

          if (search.loadType == 'search') {
            const track = {
              identifier: search.data[0].info.identifier,
              isSeekable: true,
              author: seed.song.artistSummary,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: seed.song.songTitle,
              uri: seed.song.songDetailUrl,
              artworkUrl: seed.art[seed.art.length - 1].url,
              isrc: null,
              sourceName: 'pandora'
            }

            tracks.push({
              encoded: null,
              info: track,
              playlistInfo: {}
            })
          }

          if (index == seeds.length - 1) {
            if (tracks.length == 0) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'station', sourceName: 'Pandora', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            const new_tracks = []
            seeds.forEach((seed2, index2) => {
              tracks.forEach((track3, index3) => {
                if (shouldStop) return;

                if (track3.info.title == seed2.song.songTitle && track3.info.author == seed2.song.artistSummary) {
                  track3.info.position = index2
                  track3.encoded = encodeTrack(track3.info)

                  new_tracks.push(track3)
                }
    
                if ((index2 == seeds.length - 1) && (index3 == tracks.length - 1)) {
                  shouldStop = true

                  debugLog('loadtracks', 4, { type: 2, loadType: 'station', sourceName: 'Pandora', playlistName: stationData.name })

                  resolve({
                    loadType: 'station',
                    data: {
                      info: {
                        name: stationData.name,
                        selectedTrack: 0,
                      },
                      pluginInfo: {},
                      tracks: new_tracks,
                    }
                  })
                }
              })
            })
          }

          index++
        })

        break
      }
      case 'podcast': {
        const podcastData = await http1makeRequest('https://www.pandora.com/api/v1/aesop/getDetails', {
          body: {
            catalogVersion: 4,
            pandoraId: lastPart
          },
          headers: {
            'Cookie': csrfToken.raw,
            'X-CsrfToken': csrfToken.parsed,
            'X-AuthToken': authToken
          },
          method: 'POST',
          disableBodyCompression: true
        })

        if (podcastData.length == 0) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: 'No matches found.' })

          return resolve({ loadType: 'empty', data: {} })
        }

        if (podcastData.message) {
          debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: podcastData.message })
      
          return resolve({ loadType: 'error', data: { message: podcastData.message, severity: 'common', cause: 'Unknown' } })
        }

        const tracks = []
        let index = 0
        let shouldStop = false

        switch (podcastData.details.podcastProgramDetails ? podcastData.details.podcastProgramDetails.type : podcastData.details.podcastEpisodeDetails.type) {
          case 'PE': {
            const podcastEpisode = podcastData.details.annotations[Object.keys(podcastData.details.annotations).find((key) => key == podcastData.details.podcastEpisodeDetails.pandoraId)]

            const search = await searchWithDefault(`${podcastEpisode.name} ${podcastEpisode.programName}`)

            if (search.loadType != 'search')
              return resolve(search)

            const track = {
              identifier: search.data[0].info.identifier,
              isSeekable: true,
              author: podcastEpisode.programName,
              length: search.data[0].info.length,
              isStream: false,
              position: 0,
              title: podcastEpisode.name,
              uri: `https://www.pandora.com${podcastEpisode.shareableUrlPath}`,
              artworkUrl: `https://content-images.p-cdn.com/${podcastEpisode.icon.artUrl}`,
              isrc: null,
              sourceName: 'pandora'
            }

            debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Pandora', track, query })

            resolve({
              loadType: 'track',
              data: {
                encoded: encodeTrack(track),
                info: track,
                playlistInfo: {}
              }
            })

            break
          }
          case 'PC': {
            const allEpisodesIdsData = await http1makeRequest('https://www.pandora.com/api/v1/aesop/getAllEpisodesByPodcastProgram', {
              body: {
                catalogVersion: 4,
                pandoraId: lastPart
              },
              headers: {
                'Cookie': csrfToken.raw,
                'X-CsrfToken': csrfToken.parsed,
                'X-AuthToken': authToken
              },
              method: 'POST',
              disableBodyCompression: true
            })

            if (allEpisodesIdsData.length == 0) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            if (allEpisodesIdsData.message) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: allEpisodesIdsData.message })

              return resolve({ loadType: 'error', data: { message: allEpisodesIdsData.message, severity: 'common', cause: 'Unknown' } })
            }

            let allEpisodesIds = []
            allEpisodesIdsData.episodes.episodesWithLabel.forEach((yearInfo) => {
              allEpisodesIds.push(...yearInfo.episodes)
            })

            if (allEpisodesIds.length > config.options.maxAlbumPlaylistLength)
              allEpisodesIds = allEpisodesIds.slice(0, config.options.maxAlbumPlaylistLength)

            const allEpisodesData = await http1makeRequest('https://www.pandora.com/api/v1/aesop/annotateObjects', {
              body: {
                catalogVersion: 4,
                pandoraIds: allEpisodesIds
              },
              headers: {
                'Cookie': csrfToken.raw,
                'X-CsrfToken': csrfToken.parsed,
                'X-AuthToken': authToken
              },
              method: 'POST',
              disableBodyCompression: true
            })

            if (allEpisodesData.length == 0) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: 'No matches found.' })

              return resolve({ loadType: 'empty', data: {} })
            }

            if (allEpisodesData.message) {
              debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: allEpisodesData.message })

              return resolve({ loadType: 'error', data: { message: allEpisodesData.message, severity: 'common', cause: 'Unknown' } })
            }

            let episodes = Object.keys(allEpisodesData.annotations)

            episodes.forEach(async (episode) => {
              episode = allEpisodesData.annotations[episode]

              const search = await searchWithDefault(`${episode.name} ${episode.programName}`)

              if (search.loadType == 'search') {
                const track = {
                  identifier: search.data[0].info.identifier,
                  isSeekable: true,
                  author: episode.programName,
                  length: search.data[0].info.length,
                  isStream: false,
                  position: 0,
                  title: episode.name,
                  uri: `https://www.pandora.com${episode.shareableUrlPath}`,
                  artworkUrl: `https://content-images.p-cdn.com/${episode.icon.artUrl}`,
                  isrc: null,
                  sourceName: 'pandora'
                }

                tracks.push({
                  encoded: null,
                  info: track,
                  playlistInfo: {}
                })
              }

              if (index == episodes.length - 1) {
                if (tracks.length == 0) {
                  debugLog('loadtracks', 4, { type: 3, loadType: 'podcast', sourceName: 'Pandora', query, message: 'No matches found.' })

                  return resolve({ loadType: 'empty', data: {} })
                }

                const new_tracks = []
                episodes.forEach((episode2, index2) => {
                  tracks.forEach((track3, index3) => {
                    if (shouldStop) return;

                    if (typeof episode2 != 'object') episode2 = allEpisodesData.annotations[episode2]

                    if (track3.info.title == episode2.name && track3.info.author == episode2.programName) {
                      track3.info.position = index2
                      track3.encoded = encodeTrack(track3.info)

                      new_tracks.push(track3)
                    }
        
                    if ((index2 == episodes.length - 1) && (index3 == tracks.length - 1)) {
                      shouldStop = true

                      const podcastName = podcastData.details.annotations[Object.keys(podcastData.details.annotations).find((key) => key == podcastData.details.podcastProgramDetails.pandoraId)].name

                      debugLog('loadtracks', 4, { type: 2, loadType: 'podcast', sourceName: 'Pandora', playlistName: podcastName })

                      resolve({
                        loadType: 'podcast',
                        data: {
                          info: {
                            name: podcastName,
                            selectedTrack: 0,
                          },
                          pluginInfo: {},
                          tracks: new_tracks,
                        }
                      })
                    }
                  })
                })
              }

              index++
            })

            break
          }
        }
      }
    }
  })
}

export default {
  init,
  search,
  loadFrom
}