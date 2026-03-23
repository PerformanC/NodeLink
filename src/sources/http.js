import { Transform } from 'node:stream'
import { encodeTrack, http1makeRequest, logger } from '../utils.js'

class IcyMetadataTransform extends Transform {
  constructor(metaInt, onMetadata) {
    super()
    this.metaInt = metaInt
    this.onMetadata = onMetadata
    this.audioBytesRemaining = metaInt
    this.pendingMetaLength = null
    this.metaChunks = []
    this.metaBytes = 0
    this.lastSignature = null
  }

  _emitMetadata(raw) {
    const cleaned = raw.replace(/\0+$/, '').trim()
    if (!cleaned) return

    const fields = {}
    const regex = /([A-Za-z0-9]+)='([^']*)'/g
    let match = null
    while ((match = regex.exec(cleaned))) {
      fields[match[1].toLowerCase()] = match[2]
    }

    const payload = {
      raw: cleaned,
      streamTitle: fields.streamtitle || null,
      streamUrl: fields.streamurl || null,
      fields
    }

    const signature = payload.raw
    if (signature && signature !== this.lastSignature) {
      this.lastSignature = signature
      this.onMetadata?.(payload)
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (this.pendingMetaLength === null) {
          const remaining = chunk.length - offset
          const toCopy = Math.min(this.audioBytesRemaining, remaining)
          if (toCopy > 0) {
            this.push(chunk.subarray(offset, offset + toCopy))
            this.audioBytesRemaining -= toCopy
            offset += toCopy
          }

          if (this.audioBytesRemaining === 0) {
            this.pendingMetaLength = -1
          }
        } else if (this.pendingMetaLength === -1) {
          if (offset >= chunk.length) break
          this.pendingMetaLength = chunk[offset] * 16
          offset += 1
          this.metaChunks = []
          this.metaBytes = 0
          if (this.pendingMetaLength === 0) {
            this.audioBytesRemaining = this.metaInt
            this.pendingMetaLength = null
          }
        } else {
          const remaining = chunk.length - offset
          const needed = this.pendingMetaLength - this.metaBytes
          const toCopy = Math.min(needed, remaining)
          if (toCopy > 0) {
            this.metaChunks.push(chunk.subarray(offset, offset + toCopy))
            this.metaBytes += toCopy
            offset += toCopy
          }

          if (this.metaBytes >= this.pendingMetaLength) {
            const raw = Buffer.concat(this.metaChunks, this.pendingMetaLength).toString('utf8')
            this._emitMetadata(raw)
            this.audioBytesRemaining = this.metaInt
            this.pendingMetaLength = null
          }
        }
      }
      callback()
    } catch (err) {
      callback(err)
    }
  }
}

export default class HttpSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = []
    this.priority = 10
  }

  async setup() {
    return true
  }

  async search(query) {
    return this.resolve(query)
  }

  async resolve(url) {
    try {
      const validAudioPrefixes = ['audio/', 'video/']
      const validApplicationTypes = ['application/octet-stream']
      const isValidMediaType = (contentType) =>
        validAudioPrefixes.some((prefix) => contentType.startsWith(prefix)) ||
        validApplicationTypes.includes(contentType) ||
        contentType === ''

      const httpConfig = this.nodelink.options?.sources?.http || {}
      const configuredResolveTimeout =
        Number(httpConfig.resolveTimeoutMs) > 0
          ? Number(httpConfig.resolveTimeoutMs)
          : 7000
      const clusterTimeout =
        Number(this.nodelink.options?.cluster?.commandTimeout) > 0
          ? Number(this.nodelink.options.cluster.commandTimeout)
          : null
      const resolveTimeout = clusterTimeout
        ? Math.min(configuredResolveTimeout, Math.max(1000, clusterTimeout - 500))
        : configuredResolveTimeout
      const configuredHeadTimeout =
        Number(httpConfig.headTimeoutMs) > 0 ? Number(httpConfig.headTimeoutMs) : 2500
      const headTimeout = Math.min(configuredHeadTimeout, resolveTimeout)
      const optimisticOnProbeFailure =
        httpConfig.optimisticOnProbeFailure !== false
      const resolveStartedAt = Date.now()
      const getRemainingTimeout = () =>
        Math.max(250, resolveTimeout - (Date.now() - resolveStartedAt))

      const headRequestDefaults = {
        timeout: headTimeout,
        maxRetries: 0
      }

      let data = await http1makeRequest(url, {
        method: 'HEAD',
        ...headRequestDefaults
      })
      const headContentType = data.headers?.['content-type'] || ''
      const headOk =
        !data.error &&
        (data.statusCode || 0) < 400 &&
        isValidMediaType(headContentType)

      if (!headOk) {
        const remainingTimeout = getRemainingTimeout()
        if (remainingTimeout <= 250) {
          if (optimisticOnProbeFailure) {
            return {
              loadType: 'track',
              data: this.buildTrack(url, data.headers || {}, true)
            }
          }
          return {
            exception: {
              message: `Resolve timeout budget exceeded for ${url}`,
              severity: 'common'
            }
          }
        }

        const getData = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true,
          headers: {
            'Icy-MetaData': '1'
          },
          timeout: remainingTimeout,
          maxRetries: 0
        })
        if (getData?.stream) getData.stream.destroy()
        data = getData
      }

      if (data.error) {
        if (optimisticOnProbeFailure) {
          logger(
            'warn',
            'HTTP Source',
            `Probe failed for ${url}, using optimistic track: ${data.error.message}`
          )
          return {
            loadType: 'track',
            data: this.buildTrack(url, {}, true)
          }
        }
        return {
          exception: { message: data.error.message, severity: 'common' }
        }
      }

      if ((data.statusCode || 0) >= 400) {
        if (optimisticOnProbeFailure) {
          logger(
            'warn',
            'HTTP Source',
            `Probe HTTP ${data.statusCode} for ${url}, using optimistic track`
          )
          return {
            loadType: 'track',
            data: this.buildTrack(url, data.headers || {}, true)
          }
        }
        return {
          exception: {
            message: `HTTP error ${data.statusCode} while resolving`,
            severity: 'common'
          }
        }
      }

      const headers = data.headers || {}
      const contentType = headers['content-type'] || ''

      const isValidMedia = isValidMediaType(contentType)

      if (!isValidMedia) {
        if (optimisticOnProbeFailure && contentType === '') {
          return {
            loadType: 'track',
            data: this.buildTrack(url, headers, true)
          }
        }
        return {
          exception: {
            message: `Unsupported content type: ${contentType}`,
            severity: 'common'
          }
        }
      }

      const isStream =
        Boolean(headers['icy-metaint']) || !('content-length' in headers)
      return {
        loadType: 'track',
        data: this.buildTrack(url, headers, isStream)
      }
    } catch (err) {
      const optimisticOnProbeFailure =
        this.nodelink.options?.sources?.http?.optimisticOnProbeFailure !== false
      if (optimisticOnProbeFailure) {
        logger(
          'warn',
          'HTTP Source',
          `Resolve exception for ${url}, using optimistic track: ${err.message}`
        )
        return {
          loadType: 'track',
          data: this.buildTrack(url, {}, true)
        }
      }
      return {
        exception: {
          message: `Failed to resolve URL: ${err.message}`,
          severity: 'common'
        }
      }
    }
  }

  buildTrack(url, headers, isStream) {
    const title = headers['icy-name'] || 'Unknown'
    const description = headers['icy-description'] || ''
    const genre = headers['icy-genre'] || ''
    const stationUrl = headers['icy-url'] || url
    const icyBr = headers['icy-br']
    const audioInfo = headers['ice-audio-info']
    const bitrate = Number.parseInt(
      icyBr || audioInfo?.split(';')?.[0]?.split('=')?.[1] || 0,
      10
    )

    const track = {
      identifier: url,
      isSeekable: !isStream,
      author: description || 'unknown',
      length: -1,
      isStream,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'http'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {
        bitrate,
        genre,
        stationUrl,
        icyBr,
        audioInfo
      }
    }
  }

  getTrackUrl(info) {
    return { url: info.uri, protocol: 'http' }
  }

  async loadStream(_decodedTrack, url) {
    try {
      const opts = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'Icy-MetaData': '1'
        }
      }
      const response = await http1makeRequest(url, opts)
      if (response.error) throw response.error

      const headers = response.headers || {}
      const contentType = headers['content-type'] || ''
      const httpStream = response.stream

      let outputStream = httpStream
      const metaInt = Number.parseInt(headers['icy-metaint'], 10)
      if (Number.isFinite(metaInt) && metaInt > 0) {
        const icyHeaders = {
          name: headers['icy-name'] || null,
          description: headers['icy-description'] || null,
          genre: headers['icy-genre'] || null,
          url: headers['icy-url'] || null,
          bitrate: headers['icy-br'] || null
        }
        const metadataStream = new IcyMetadataTransform(metaInt, (metadata) => {
          outputStream.emit('icyMetadata', {
            metadata,
            icy: icyHeaders,
            receivedAt: Date.now()
          })
        })
        httpStream.pipe(metadataStream)
        outputStream = metadataStream
      }

      outputStream.on('end', () => {
        logger(
          'debug',
          'HTTP Source',
          `Stream ended for ${url}, emitting finishBuffering.`
        )
        outputStream.emit('finishBuffering')
      })

      outputStream.on('error', (err) => {
        logger('error', 'HTTP Source', `Stream error: ${err.message}`)
      })

      return { stream: outputStream, type: contentType }
    } catch (err) {
      logger('error', 'Sources', `Failed to load http stream: ${err.message}`)
      return { exception: { message: err.message, severity: 'common' } }
    }
  }
}
