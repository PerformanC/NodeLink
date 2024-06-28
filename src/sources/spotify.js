import crypto from 'node:crypto'

import config from '../../config.js'
import { debugLog, makeRequest, encodeTrack, http1makeRequest } from '../utils.js'

let playerInfo = {}

async function init() {
  debugLog('spotify', 5, { type: 1, message: 'Fetching token...' })

  const { body: token } = await makeRequest('https://open.spotify.com/get_access_token', {
    headers: {
      ...(config.search.sources.spotify.sp_dc !== 'DISABLED' ? { Cookie: `sp_dc=${config.search.sources.spotify.sp_dc}` } : {})
    },
    method: 'GET'
  })

  if (typeof token !== 'object') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch Spotify token.' })

    globalThis.NodeLinkSources.Spotify = false

    return;
  }

  const { body: data } = await http1makeRequest(`https://clienttoken.spotify.com/v1/clienttoken`, {
    body: {
      client_data: {
        client_version: '1.2.9.2269.g2fe25d39',
        client_id: token.clientId,
        js_sdk_data: {
          device_brand: 'unknown',
          device_model: 'unknown',
          os: 'linux',
          os_version: 'unknown',
          device_id: crypto.randomUUID(),
          device_type: 'computer'
        }
      }
    },
    headers: {
      'Accept': 'application/json'
    },
    method: 'POST',
    disableBodyCompression: true
  })

  if (typeof data !== 'object') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch client token.' })

    globalThis.NodeLinkSources.Spotify = false

    return;
  }

  if (data.response_type !== 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
    debugLog('spotify', 5, { type: 2, message: 'Failed to fetch client token.' })

    globalThis.NodeLinkSources.Spotify = false

    return;
  }

  playerInfo = {
    accessToken: token.accessToken,
    clientToken: data.granted_token.token
  }

  debugLog('spotify', 5, { type: 1, message: 'Successfully fetched token.' })

  globalThis.NodeLinkSources.Spotify = true
}

async function search(query) {
  if (!globalThis.NodeLinkSources.Spotify) {
    debugLog('search', 4, { type: 3, sourceName: 'Spotify', query, message: 'Spotify source is not available.' })

    return {
      loadType: 'error',
      data: {
        message: 'Spotify source is not available.',
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  return new Promise(async (resolve) => {
    debugLog('search', 4, { type: 1, sourceName: 'Spotify', query })

    const limit = config.options.maxSearchResults >= 50 ? 50 : config.options.maxSearchResults

    const { body: data } = await makeRequest(`https://api.spotify.com/v1/search?q=${encodeURI(query)}&type=track&limit=${limit}&market=${config.search.sources.spotify.market}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${playerInfo.accessToken}`,
        'client-token': playerInfo.clientToken,
        'accept': 'application/json'
      }
    })

    if (data.tracks.total === 0) {
      debugLog('search', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

      return resolve({
        loadType: 'empty',
        data: {}
      })
    }
      
    const tracks = []

    data.tracks.items.forEach(async (items) => {
      const track = {
        identifier: items.id,
        isSeekable: true,
        author: items.artists.map((artist) => artist.name).join(', '),
        length: items.duration_ms,
        isStream: false,
        position: 0,
        title: items.name,
        uri: items.href,
        artworkUrl: items.album.images[0].url,
        isrc: items.external_ids.isrc,
        sourceName: 'spotify'
      }

      tracks.push({
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {}
      })
    })

    if (tracks.length === 0) {
      debugLog('search', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

      return resolve({
        loadType: 'empty',
        data: {}
      })
    }

    debugLog('search', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', tracksLen: tracks.length, query })

    return resolve({
      loadType: 'search',
      data: tracks
    })
  })   
}

async function loadFrom(query, type) {
  if (!globalThis.NodeLinkSources.Spotify) {
    debugLog('loadtracks', 4, { type: 3, sourceName: 'Spotify', query, message: 'Spotify source is not available.' })

    return {
      loadType: 'error',
      data: {
        message: 'Spotify source is not available.',
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  return new Promise(async (resolve) => {
    let endpoint

    switch (type[1]) {
      case 'track': {
        endpoint = `/tracks/${type[2]}?limit=${config.options.maxSearchResults}`

        break
      }
      case 'playlist': {
        endpoint = `/playlists/${type[2]}`

        break
      }
      case 'album': {
        endpoint = `/albums/${type[2]}?limit=${config.options.maxAlbumPlaylistLength < 100 ? config.options.maxAlbumPlaylistLength : 100}`

        break
      }
      case 'episode': {
        endpoint = `/episodes/${type[2]}?market=${config.search.sources.spotify.market}&limit=${config.options.maxAlbumPlaylistLength < 100 ? config.options.maxAlbumPlaylistLength : 100}`

        break
      }
      case 'show': {
        endpoint = `/shows/${type[2]}?market=${config.search.sources.spotify.market}&limit=${config.options.maxAlbumPlaylistLength < 100 ? config.options.maxAlbumPlaylistLength : 100}`

        break
      }
      default: {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: 'No matches found.' })

        return resolve({
          loadType: 'empty',
          data: {}
        })
      }
    }

    debugLog('loadtracks', 4, { type: 1, loadType: type[1], sourceName: 'Spotify', query })

    let { body: data } = await makeRequest(`https://api.spotify.com/v1${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${playerInfo.accessToken}`
      }
    })

    if (data.error) {
      if (data.error.status === 401) {
        await init()

        data = await makeRequest(`https://api.spotify.com/v1${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${playerInfo.accessToken}`
          }
        })
        data = data.body
      }

      if (data.error?.status === 400) {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: 'No matches found.' })

        return resolve({
          loadType: 'empty',
          data: {}
        })
      }

      if (data.error?.message === 'Invalid playlist Id') {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: 'No matches found.' })

        return resolve({
          loadType: 'empty',
          data: {}
        })
      }
    
      if (data.error) {
        debugLog('loadtracks', 4, { type: 3, loadType: type[1], sourceName: 'Spotify', query, message: data.error.message })

        return resolve({
          loadType: 'error',
          data: {
            message: data.error.message,
            severity: 'fault',
            cause: 'Unknown'
          }
        })
      }
    }

    switch (type[1]) {
      case 'track': {
        const track = {
          identifier: data.id,
          isSeekable: true,
          author: data.artists[0].name,
          length: data.duration_ms,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.album.images[0].url,
          isrc: data.external_ids?.isrc || null,
          sourceName: 'spotify'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', track, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }
      case 'episode': {
        const track = {
          identifier: data.id,
          isSeekable: true,
          author: data.show.publisher,
          length: data.duration_ms,
          isStream: false,
          position: 0,
          title: data.name,
          uri: data.external_urls.spotify,
          artworkUrl: data.images[0].url,
          isrc: data.external_ids?.isrc || null,
          sourceName: 'spotify'
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'Spotify', track, query })

        return resolve({
          loadType: 'track',
          data: {
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          }
        })
      }
      case 'playlist':
      case 'album': {
        const tracks = []
        let index = 0

        if (data.tracks.total > config.options.maxAlbumPlaylistLength)
          data.tracks.total = config.options.maxAlbumPlaylistLength

        const fragments = []
        const fragmentLengths = []
        
        if (data.tracks.items.length === data.tracks.total) {
          fragmentLengths.push(data.tracks.total)
        } else {
          for (let i = data.tracks.items.length; i != data.tracks.total;) {
            const requestLimit = data.tracks.total - i > 100 ? 100 : data.tracks.total - i

            fragmentLengths.push(requestLimit)
            i += requestLimit
          }
        }

        fragmentLengths.forEach(async (limit, i) => {
          if (fragmentLengths.length !== 0) {
            let url = `https://api.spotify.com/v1${endpoint}/tracks?offset=${(i + 1) * 100}&limit=${limit}`

            const { body: data2 } = await makeRequest(url, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${playerInfo.accessToken}`
              }
            })

            fragments[i] = data2.items

            if (index === fragmentLengths.length - 1)
              data.tracks.items = data.tracks.items.concat(...fragments)
          }

          if (index === fragmentLengths.length - 1) {
            data.tracks.items.forEach(async (item) => {
              item = type[1] === 'playlist' ? item.track : item

              if (item) {
                const track = {
                  identifier: item.id || 'unknown',
                  isSeekable: true,
                  author: item.artists[0].name,
                  length: item.duration_ms,
                  isStream: false,
                  position: 0,
                  title: item.name,
                  uri: item.external_urls.spotify,
                  artworkUrl: item.album ? item.album.images[0]?.url : null,
                  isrc: item.external_ids?.isrc || null,
                  sourceName: 'spotify'
                }
      
                tracks.push({
                  encoded: encodeTrack(track),
                  info: track,
                  pluginInfo: {}
                })
              }
            })
    
            if (tracks.length === 0) {
              debugLog('loadtracks', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })
    
              return resolve({
                loadType: 'empty',
                data: {}
              })
            }
    
            debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: 'Spotify', playlistName: data.name })
    
            return resolve({
              loadType: type[1],
              data: {
                info: {
                  name: data.name,
                  selectedTrack: 0
                },
                pluginInfo: {},
                tracks
              }
            })
          }

          index++
        })

        break
      }
      case 'show': {
        const tracks = []

        data.episodes.items.forEach(async (episode) => {
          const track = {
            identifier: episode.id,
            isSeekable: true,
            author: data.publisher,
            length: episode.duration_ms,
            isStream: false,
            position: 0,
            title: episode.name,
            uri: episode.external_urls.spotify,
            artworkUrl: episode.images[0].url,
            isrc: episode.external_ids?.isrc || null,
            sourceName: 'spotify'
          }

          tracks.push({
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          })
        })

        if (tracks.length === 0) {
          debugLog('loadtracks', 4, { type: 3, sourceName: 'Spotify', query, message: 'No matches found.' })

          return resolve({
            loadType: 'empty',
            data: {}
          })
        }

        debugLog('loadtracks', 4, { type: 2, loadType: 'show', sourceName: 'Spotify', playlistName: data.name })

        return resolve({
          loadType: 'show',
          data: {
            info: {
              name: data.name,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        })
      }
    }
  })
}

async function loadLyrics(decodedTrack, _language) {
  if (!globalThis.NodeLinkSources.Spotify) {
    debugLog('loadlyrics', 4, { type: 3, sourceName: 'Spotify', message: 'Spotify source is not available.' })

    return {
      loadType: 'error',
      data: {
        message: 'Spotify source is not available.',
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  const identifier = /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:[^?]+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(decodedTrack.uri)

  if (config.search.sources.spotify.sp_dc === 'DISABLED') {
    debugLog('loadlyrics', 4, { type: 3, sourceName: 'Spotify', message: 'Spotify lyrics are disabled.' })

    return null
  }

  const { body: data, statusCode } = await makeRequest(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${identifier[2]}?format=json&vocalRemoval=false&market=from_token`, {
    headers: {
      'authorization': `Bearer ${playerInfo.accessToken}`,
      'client-token': playerInfo.clientToken,
      'app-platform': 'WebPlayer'
    },
    method: 'GET'
  })

  if (statusCode === 404) {
    debugLog('loadlyrics', 4, { type: 3, sourceName: 'Spotify', message: 'No lyrics found.' })

    return null
  }

  const lyricsEvents = []
  data.lyrics.lines.forEach((event, index) => {
    if (index === data.lyrics.lines.length - 1) return;

    lyricsEvents.push({
      startTime: Number(event.startTimeMs),
      endTime: Number(data.lyrics.lines[index + 1] ? data.lyrics.lines[index + 1].startTimeMs : data.lyrics.durationMs),
      text: event.words
    })
  })

  return {
    loadType: 'lyricsSingle',
    data: {
      name: data.lyrics.language,
      synced: data.lyrics.syncType === 'LINE_SYNCED',
      data: lyricsEvents,
      rtl: false
    }
  }
}

export default {
  init,
  search,
  loadFrom,
  loadLyrics
}
