import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

export default class ShazamSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['shsearch', 'szsearch']
    this.patterns = [/https?:\/\/(?:www\.)?shazam\.com\/song\/\d+\/([^/?#]+)/]
    this.priority = 90
    this.allowExplicit = true
  }

  async setup() {
    const shazamConfig = this.config.sources?.shazam || {}
    this.allowExplicit = shazamConfig.allowExplicit ?? true
    return true
  }

  async search(query) {
    try {
      const limit = this.config.maxSearchResults || 10
      const url = `https://www.shazam.com/services/amapi/v1/catalog/US/search?types=songs&term=${encodeURIComponent(query)}&limit=${limit}`

      const { body: data, statusCode } = await http1makeRequest(url)
      if (statusCode !== 200) return { loadType: 'empty', data: {} }

      const songs = data?.results?.songs?.data || []
      if (!songs.length) return { loadType: 'empty', data: {} }

      const tracks = []
      for (let i = 0; i < songs.length; i++) {
        const t = this._buildTrack(songs[i])
        if (t) tracks.push(t)
      }

      return { loadType: 'search', data: tracks }
    } catch (error) {
      logger('error', 'Shazam', `Search failed for ${query}: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const res = await http1makeRequest(url)
      if (res.statusCode !== 200) return { loadType: 'empty', data: {} }

      const html =
        typeof res.body === 'string' ? res.body : String(res.body ?? '')

      const extractTextAfterClass = (classPart) => {
        let from = 0
        while (true) {
          const c = html.indexOf('class="', from)
          if (c === -1) return null

          const q = html.indexOf('"', c + 7)
          if (q === -1) return null

          const cls = html.slice(c + 7, q)
          if (cls.includes(classPart)) {
            const gt = html.indexOf('>', q)
            if (gt === -1) return null
            const lt = html.indexOf('<', gt + 1)
            if (lt === -1) return null
            const text = html.slice(gt + 1, lt).trim()
            return text || null
          }

          from = q + 1
        }
      }

      const extractHrefStartingAt = (hrefPrefix) => {
        const i = html.indexOf(hrefPrefix)
        if (i === -1) return null
        const start = i + 6
        const end = html.indexOf('"', start)
        return end > start ? html.slice(start, end) : null
      }

      const extractArtworkFromImgAlt = () => {
        const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)
        if (ogImage) return ogImage[1]

        let altIdx = html.indexOf('alt="album cover"')
        if (altIdx === -1) altIdx = html.indexOf('alt="song thumbnail"')
        if (altIdx === -1) return null

        const imgStart = html.lastIndexOf('<img', altIdx)
        if (imgStart === -1) return null
        const imgEnd = html.indexOf('>', altIdx)
        if (imgEnd === -1) return null

        const tag = html.slice(imgStart, imgEnd + 1)
        const s = tag.indexOf('srcset="')
        if (s === -1) return null

        const valStart = s + 8
        const valEnd = tag.indexOf('"', valStart)
        if (valEnd === -1) return null

        const srcset = tag.slice(valStart, valEnd)
        const space = srcset.indexOf(' ')
        return (space === -1 ? srcset : srcset.slice(0, space)) || null
      }

      const parseTimeToMs = (timeStr) => {
        if (!timeStr) return 0

        const isoMatch = timeStr.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/)
        if (isoMatch) {
          const hours = parseInt(isoMatch[1] || '0', 10)
          const minutes = parseInt(isoMatch[2] || '0', 10)
          const seconds = parseFloat(isoMatch[3] || '0')
          return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
        }

        const parts = timeStr.split(':').map(Number)
        if (parts.some(isNaN)) return 0

        if (parts.length === 3) {
          return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
        } else if (parts.length === 2) {
          return (parts[0] * 60 + parts[1]) * 1000
        } else if (parts.length === 1) {
          return parts[0] * 1000
        }

        return 0
      }

      const extractDurationFromHtml = () => {
        const endTimeRegex = /\\?"endTime\\?"\s*:\s*\\?"([^"\\]+)\\?"/g
        let maxDuration = 0
        let match

        while ((match = endTimeRegex.exec(html)) !== null) {
          const duration = parseTimeToMs(match[1])
          if (duration > maxDuration) {
            maxDuration = duration
          }
        }

        return maxDuration
      }

      const extractIsrcFromHtml = () => {
        const isrcMatch = html.match(/\\?"isrc\\?"\s*:\s*\\?"([A-Z]{2}[A-Z0-9]{3}\d{7})\\?"/)
        return isrcMatch ? isrcMatch[1] : null
      }

      const appleMusicUrl = extractHrefStartingAt(
        'href="https://www.shazam.com/applemusic/song/'
      )

      const title =
        extractTextAfterClass('NewTrackPageHeader_trackTitle__') || 'Unknown'
      const artist =
        extractTextAfterClass('TrackPageArtistLink_artistNameText__') ||
        'Unknown'

      const artworkUrl = extractArtworkFromImgAlt()

      if (title === 'Unknown' && !appleMusicUrl)
        return { loadType: 'empty', data: {} }

      const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url
      const identifier = cleanUrl.slice(cleanUrl.lastIndexOf('/') + 1)

      const duration = extractDurationFromHtml()
      const isrc = extractIsrcFromHtml()

      const trackInfo = {
        identifier,
        isSeekable: true,
        author: artist,
        length: duration,
        isStream: false,
        position: 0,
        title,
        uri: url,
        artworkUrl,
        isrc,
        sourceName: 'shazam',
        appleMusicUrl
      }

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        }
      }
    } catch (error) {
      logger('error', 'Shazam', `Failed to resolve ${url}: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    try {
      const query = `${decodedTrack.title} ${decodedTrack.author}`
      const hasResults = (r) => r?.loadType === 'search' && r.data?.length

      let searchResult = await this.nodelink.sources.search(
        'youtube',
        query,
        'ytmsearch'
      )

      if (!hasResults(searchResult)) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (!hasResults(searchResult)) {
        return {
          exception: { message: 'No alternative found.', severity: 'fault' }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

      if (!bestMatch) {
        return {
          exception: { message: 'No suitable match.', severity: 'fault' }
        }
      }

      const stream = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...stream }
    } catch (error) {
      logger('error', 'Shazam', `Failed to get track URL: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  _buildTrack(item) {
    if (!item?.id) return null

    const attributes = item.attributes || {}
    const artwork = this._parseArtwork(attributes.artwork)
    const isExplicit = attributes.contentRating === 'explicit'

    let trackUri = attributes.url || ''
    if (trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
    }

    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: attributes.artistName || 'Unknown',
      length: attributes.durationInMillis ?? 0,
      isStream: false,
      position: 0,
      title: attributes.name || 'Unknown',
      uri: trackUri,
      artworkUrl: artwork,
      isrc: attributes.isrc || null,
      sourceName: 'shazam'
    }

    return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: {} }
  }

  _parseArtwork(artworkData) {
    if (!artworkData?.url) return null
    return artworkData.url
      .replace('{w}', artworkData.width)
      .replace('{h}', artworkData.height)
  }
}