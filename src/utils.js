import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'

import config from '../config.js'
import constants from '../constants.js'

if (config.options.logFile) {
  if (!fs.existsSync(config.options.logFile)) fs.writeFileSync(config.options.logFile, '')

  fs.writeFileSync(config.options.logFile, `[ LOG ] NodeLink log file created at ${new Date().toLocaleString()}\n\n\n`)
}

function consoleLog(message) {
  console.log(message)

  if (config.options.logFile) {
    message = message.replace(/\u001b\[\d+m/g, '')

    const data = fs.readFileSync(config.options.logFile, 'utf8')

    fs.writeFileSync(config.options.logFile, `${data}\n[ LOG ] ${message}`)
  }
}

function consoleWarn(message) {
  console.warn(message)

  if (config.options.logFile) {
    message = message.replace(/\u001b\[\d+m/g, '')

    const data = fs.readFileSync(config.options.logFile, 'utf8')

    fs.writeFileSync(config.options.logFile, `${data}\n[WARN ] ${message}`)
  }
}

function consoleError(message) {
  console.error(message)

  if (config.options.logFile) {
    message = message.replace(/\u001b\[\d+m/g, '')

    const data = fs.readFileSync(config.options.logFile, 'utf8')

    fs.writeFileSync(config.options.logFile, `${data}\n[ERROR] ${message}`)
  }
}

export function randomLetters(size) {
  let result = ''
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  
  let counter = 0
  while (counter < size) {
    result += characters.charAt(Math.floor(Math.random() * characters.length))
    counter++
  }
  
  return result
}

function _http1Events(request, headers, statusCode) {
  return new Promise((resolve) => {
    let data = ''

    request.setEncoding('utf8')
    request.on('data', (chunk) => data += chunk)
    request.on('end', () => {
      resolve({
        statusCode: statusCode,
        headers: headers,
        body: (headers && headers['content-type'] && headers['content-type'].startsWith('application/json')) ? JSON.parse(data) : data
      })
    })
  })
}

export function http1makeRequest(url, options) { 
  return new Promise(async (resolve, reject) => {
    let compression = null

    let req = (url.startsWith('https') ? https : http).request(url, {
      method: options.method,
      headers: {
        'Accept-Encoding': 'br, gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
        'DNT': '1',
        ...(options.headers || {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    }, async (res) => {
      const statusCode = res.statusCode
      const headers = res.headers

      if (headers.location) {
        resolve(http1makeRequest(headers.location, options))

        return res.destroy()
      }

      switch (res.headers['content-encoding']) {
        case 'deflate': {
          compression = zlib.createInflate()
          break
        }
        case 'br': {
          compression = zlib.createBrotliDecompress()
          break
        }
        case 'gzip': {
          compression = zlib.createGunzip()
          break
        }
      }

      if (compression) {
        res.pipe(compression)

        if (options.streamOnly) {
          return resolve({
            statusCode,
            headers,
            stream: compression
          })
        }
        
        resolve(await _http1Events(compression, headers, statusCode))
      } else {
        if (options.streamOnly) {
          return resolve({
            statusCode,
            headers,
            stream: res
          })
        }

        resolve(await _http1Events(res, headers, statusCode))
      }
    })

    if (options.body) {
      if (options.disableBodyCompression || process.versions.deno)
        req.end(JSON.stringify(options.body))
      else zlib.gzip(JSON.stringify(options.body), (error, data) => {
        if (error) throw new Error(`\u001b[31mhttp1makeRequest\u001b[37m]: Failed gziping body: ${error}`)
        req.end(data)
      })
    } else req.end()

    req.on('error', (error) => {
      consoleError(`[\u001b[31mhttp1makeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

      reject(error)
    })
  })
}

function _http2Events(request, headers) {
  return new Promise((resolve) => {
    let data = ''

    request.setEncoding('utf8')
    request.on('data', (chunk) => data += chunk)
    request.on('end', () => {
      resolve({
        statusCode: headers[':status'],
        headers: headers,
        body: (headers && headers['content-type'] && headers['content-type'].startsWith('application/json')) ? JSON.parse(data) : data
      })
    })
  })
}

export function makeRequest(url, options) {
  if (process.versions.deno) return http1makeRequest(url, options)

  return new Promise(async (resolve) => {
    const parsedUrl = new URL(url)
    let compression = null

    const client = http2.connect(parsedUrl.origin)

    let reqOptions = {
      ':method': options.method,
      ':path': parsedUrl.pathname + parsedUrl.search,
      'Accept-Encoding': 'br, gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
      'DNT': '1',
      ...(options.headers || {})
    }

    if (options.body) {
      if (!options.disableBodyCompression) reqOptions['Content-Encoding'] = 'gzip'

      reqOptions['Content-Type'] = 'application/json'
    }

    let req = client.request(reqOptions)

    client.on('error', () => { /* Add listener or else will crash */ })

    req.on('error', (error) => {
      consoleError(`[\u001b[31mmakeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

      resolve({ error })
    })

    req.on('response', async (headers) => {
      if (headers.location) {
        client.close()
        req.destroy()

        return resolve(makeRequest(headers.location, options))
      }

      switch (headers['content-encoding']) {
        case 'deflate': {
          compression = zlib.createInflate()
          break
        }
        case 'br': {
          compression = zlib.createBrotliDecompress()
          break
        }
        case 'gzip': {
          compression = zlib.createGunzip()
          break
        }
      }

      if (compression) {
        req.pipe(compression)

        if (options.streamOnly) {
          req.on('end', () => client.close())

          return resolve({
            statusCode: headers[':status'],
            headers: headers,
            stream: compression
          })
        }

        compression.on('error', (error) => {
          consoleError(`[\u001b[31mmakeRequest\u001b[37m]: Failed decompressing HTTP response: \u001b[31m${error}\u001b[37m`)

          resolve({ error })
        })

        resolve(await _http2Events(compression, headers))

        client.close()
      } else {
        if (options.streamOnly) {
          req.on('end', () => client.close())

          return resolve({
            statusCode: headers[':status'],
            headers: headers,
            stream: req
          })
        }

        resolve(await _http2Events(req, headers))

        client.close()
      }
    })

    if (options.body) {
      if (options.disableBodyCompression)
        req.end(JSON.stringify(options.body))
      else zlib.gzip(JSON.stringify(options.body), (error, data) => {
        if (error) throw new Error(`\u001b[31mmakeRequest\u001b[37m]: Failed gziping body: ${error}`)
        req.end(data)
      })
    } else req.end()
  })
}

class EncodeClass {
  constructor() {
    this.position = 0
    this.buffer = Buffer.alloc(512)
  }

  changeBytes(bytes) {
    if (this.position + bytes > this.buffer.length) {
      const newBuffer = Buffer.alloc(Math.max(this.buffer.length * 2, this.position + bytes))
      this.buffer.copy(newBuffer)
      this.buffer = newBuffer
    }
    this.position += bytes
    return this.position - bytes
  }

  write(type, value) {
    switch (type) {
      case 'byte': {
        this.buffer[this.changeBytes(1)] = value
        break
      }
      case 'unsignedShort': {
        this.buffer.writeUInt16BE(value, this.changeBytes(2))
        break
      }
      case 'int': {
        this.buffer.writeInt32BE(value, this.changeBytes(4))
        break
      }
      case 'long': {
        const msb = value / BigInt(2 ** 32)
        const lsb = value % BigInt(2 ** 32)

        this.write('int', Number(msb))
        this.write('int', Number(lsb))
        break
      }
      case 'utf': {
        const len = Buffer.byteLength(value, 'utf8')
        this.write('unsignedShort', len)
        const start = this.changeBytes(len)
        this.buffer.write(value, start, len, 'utf8')
        break
      }
    }
  }

  result() {
    return this.buffer.subarray(0, this.position)
  }
}

export function encodeTrack(obj) {
  try {
    const buf = new EncodeClass()

    buf.write('byte', 3)
    buf.write('utf', obj.title)
    buf.write('utf', obj.author)
    buf.write('long', BigInt(obj.length))
    buf.write('utf', obj.identifier)
    buf.write('byte', obj.isStream ? 1 : 0)
    buf.write('byte', obj.uri ? 1 : 0)
    if (obj.uri) buf.write('utf', obj.uri)
    buf.write('byte', obj.artworkUrl ? 1 : 0)
    if (obj.artworkUrl) buf.write('utf', obj.artworkUrl)
    buf.write('byte', obj.isrc ? 1 : 0)
    if (obj.isrc) buf.write('utf', obj.isrc)
    buf.write('utf', obj.sourceName)
    buf.write('long', BigInt(obj.position))

    const buffer = buf.result()
    const result = Buffer.alloc(buffer.length + 4)

    result.writeInt32BE(buffer.length | (1 << 30))
    buffer.copy(result, 4)

    return result.toString('base64')
  } catch {
    return null
  }
}

class DecodeClass {
  constructor(buffer) {
    this.position = 0
    this.buffer = buffer
  }

  changeBytes(bytes) {
    this.position += bytes
    return this.position - bytes
  }

  read(type) {
    switch (type) {
      case 'byte': {
        return this.buffer[this.changeBytes(1)]
      }
      case 'unsignedShort': {
        const result = this.buffer.readUInt16BE(this.changeBytes(2))
        return result
      }
      case 'int': {
        const result = this.buffer.readInt32BE(this.changeBytes(4))
        return result
      }
      case 'long': {
        const msb = BigInt(this.read('int'))
        const lsb = BigInt(this.read('int'))

        return msb * BigInt(2 ** 32) + lsb
      }
      case 'utf': {
        const len = this.read('unsignedShort')
        const start = this.changeBytes(len)
        const result = this.buffer.toString('utf8', start, start + len)
        return result
      }
    }
  }
}

export function decodeTrack(track) {
  try {
    const buf = new DecodeClass(Buffer.from(track, 'base64'))

    const version = ((buf.read('int') & 0xC0000000) >> 30 & 1) !== 0 ? buf.read('byte') : 1

    switch (version) {
      case 1: {
        return {
          title: buf.read('utf'),
          author: buf.read('utf'),
          length: Number(buf.read('long')),
          identifier: buf.read('utf'),
          isStream: buf.read('byte') === 1,
          uri: null,
          source: buf.read('utf'),
          position: Number(buf.read('long'))
        }
      }
      case 2: {
        return {
          title: buf.read('utf'),
          author: buf.read('utf'),
          length: Number(buf.read('long')),
          identifier: buf.read('utf'),
          isStream: buf.read('byte') === 1,
          uri: buf.read('byte') === 1 ? buf.read('utf') : null,
          source: buf.read('utf'),
          position: Number(buf.read('long'))
        }
      }
      case 3: {
        return {
          title: buf.read('utf'),
          author: buf.read('utf'),
          length: Number(buf.read('long')),
          identifier: buf.read('utf'),
          isSeekable: true,
          isStream: buf.read('byte') === 1,
          uri: buf.read('byte') === 1 ? buf.read('utf') : null,
          artworkUrl: buf.read('byte') === 1 ? buf.read('utf') : null,
          isrc: buf.read('byte') === 1 ? buf.read('utf') : null,
          sourceName: buf.read('utf'),
          position: Number(buf.read('long'))
        }
      }
    }
  } catch {
    return null
  }
}

export function debugLog(name, type, options) {
  switch (type) {
    case 1: {
      if (!config.debug.request.enabled) return;

      if (options.headers) {
        options.headers.authorization = 'REDACTED'
        options.headers.host = 'REDACTED'
      }

      if (options.error)
        consoleError(`[\u001b[32m${name}\u001b[37m]: Detected an error in a request: \u001b[31m${options.error}\u001b[37m${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)
      else
        consoleLog(`[\u001b[32m${name}\u001b[37m]: Received a request from client.${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

      break
    }
    case 2: {
      switch (name) {
        case 'trackStart': {
          if (!config.debug.track.start) return;

          consoleLog(`[\u001b[32mtrackStart\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m.`)

            break
        }
        case 'trackEnd': {
          if (!config.debug.track.end) return;

          consoleLog(`[\u001b[32mtrackEnd\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m because was \u001b[94m${options.reason}\u001b[37m.`)

          break
        }
        case 'trackException': {
          if (!config.debug.track.exception) return;

          consoleError(`[\u001b[31mtrackException\u001b[37m]: \u001b[94m${options.track?.title || 'None'}\u001b[37m by \u001b[94m${options.track?.author || 'none'}\u001b[37m: \u001b[31m${options.exception}\u001b[37m`)

          break
        }
        case 'trackStuck': {
          if (!config.debug.track.stuck) return;

          consoleWarn(`[\u001b[33mtrackStuck\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m: \u001b[33m${config.options.threshold}ms have passed.\u001b[37m`)

          break
        }
      }

      break
    }
    case 3: {
      switch (name) {
        case 'connect': {
          if (!config.debug.websocket.connect) return;

          if (options.error)
            return consoleError(`[\u001b[31mwebsocket\u001b[37m]: \u001b[31m${options.error}\u001b[37m\n Name: \u001b[94m${options.name}\u001b[37m`)

          consoleLog(`[\u001b[32mwebsocket\u001b[37m]: \u001b[94m${options.name}\u001b[37m@\u001b[94m${options.version}\u001b[37m client connected to NodeLink.`)

          break
        }
        case 'disconnect': {
          if (!config.debug.websocket.disconnect) return;

          consoleError(`[\u001b[33mwebsocket\u001b[37m]: A connection was closed with a client.\n Code: \u001b[33m${options.code}\u001b[37m\n Reason: \u001b[33m${options.reason === '' ? 'No reason provided' : options.reason}\u001b[37m`)
        
          break
        }
        case 'error': {
          if (!config.debug.websocket.error) return;

          consoleError(`[\u001b[31mwebsocketError\u001b[37m]: \u001b[94m${options.name}\u001b[37m@\u001b[94m${options.version}\u001b[37m ran into an error: \u001b[31m${options.error}\u001b[37m`)

          break
        }
        case 'connectCD': {
          if (!config.debug.websocket.connectCD) return;

          consoleLog(`[\u001b[32mwebsocketCD\u001b[37m]: \u001b[94m${options.name}\u001b[37m@\u001b[94m${options.version}\u001b[37m client connected to NodeLink.\n Guild: \u001b[94m${options.guildId}\u001b[37m`)

          break
        }
        case 'disconnectCD': {
          if (!config.debug.websocket.disconnectCD) return;

          consoleError(`[\u001b[32mwebsocketCD\u001b[37m]: Connection with \u001b[94m${options.name}\u001b[37m@\u001b[94m${options.version}\u001b[37m was closed.\n Guild: \u001b[94m${options.guildId}\u001b[37m\n Code: \u001b[33m${options.code}\u001b[37m\n Reason: \u001b[33m${options.reason === '' ? 'No reason provided' : options.reason}\u001b[37m`)

          break
        }
        case 'sentDataCD': {
          if (!config.debug.websocket.sentDataCD) return;

          consoleLog(`[\u001b[32msentData\u001b[37m]: Sent data to \u001b[94m${options.clientsAmount}\u001b[37m clients.\n Guild: \u001b[94m${options.guildId}\u001b[37m`)

          break
        }
        default: {
          if (!config.debug.request.error) return;

          consoleError(`[\u001b[31m${name}\u001b[37m]: \u001b[31m${options.error}\u001b[37m${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}${options.stack ? `\n Stack: ${options.stack}` : ''}`)

          break
        }
      }

      break
    }
    case 4: {
      switch (name) {
        case 'loadtracks': {
          if (options.type === 1 && config.debug.sources.loadtrack.request)
            consoleLog(`[\u001b[32mloadTracks\u001b[37m]: Loading \u001b[94m${options.loadType}\u001b[37m from ${options.sourceName}: ${options.query}`)

          if (options.type === 2 && config.debug.sources.loadtrack.results) {
            if (options.loadType !== 'search' && options.loadType !== 'track')
              consoleLog(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.playlistName}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m.`)
            else
              consoleLog(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: ${options.query}`)
          }

          if (options.type === 3 && config.debug.sources.loadtrack.exception)
            consoleError(`[\u001b[31mloadTracks\u001b[37m]: Exception loading \u001b[94m${options.loadType}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'search': {
          if (options.type === 1 && config.debug.sources.search.request)
            consoleLog(`[\u001b[32msearch\u001b[37m]: Searching for \u001b[94m${options.query}\u001b[37m on \u001b[94m${options.sourceName}\u001b[37m`)
          
          if (options.type === 2 && config.debug.sources.search.results)
            consoleLog(`[\u001b[32msearch\u001b[37m]: Found \u001b[94m${options.tracksLen}\u001b[37m tracks on \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type === 3 && config.debug.sources.search.exception)
            consoleError(`[\u001b[31msearch\u001b[37m]: Exception from ${options.sourceName} for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'retrieveStream': {
          if (!config.debug.sources.retrieveStream) return;

          if (options.type === 1)
            consoleLog(`[\u001b[32mretrieveStream\u001b[37m]: Retrieved from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type === 2)
            consoleError(`[\u001b[31mretrieveStream\u001b[37m]: Exception from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m${options.stack ? `\n Stack: ${options.stack}` : ''}`)

          break
        }
        case 'loadlyrics': {
          if (options.type === 1 && config.debug.sources.loadlyrics.request)
            consoleLog(`[\u001b[32mloadCaptions\u001b[37m]: Loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type === 2 && config.debug.sources.loadlyrics.results)
            consoleLog(`[\u001b[32mloadCaptions\u001b[37m]: Loaded captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type === 3 && config.debug.sources.loadlyrics.exception)
            consoleError(`[\u001b[31mloadCaptions\u001b[37m]: Exception loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
      }

      break
    }
    case 5: {
      switch (name) {
        case 'youtube': {
          if (options.type === 1 && config.debug.youtube.success)
            consoleLog(`[\u001b[32myoutube\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.youtube.error)
            consoleError(`[\u001b[31myoutube\u001b[37m]: ${options.message}`)

          break
        }

        case 'pandora': {
          if (options.type === 1 && config.debug.pandora.success)
            consoleLog(`[\u001b[32mpandora\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.pandora.error)
            consoleError(`[\u001b[31mpandora\u001b[37m]: ${options.message}`)

          break
        }
        case 'deezer': {
          if (options.type === 1 && config.debug.deezer.success)
            consoleLog(`[\u001b[32mdeezer\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.deezer.error)
            consoleError(`[\u001b[31mdeezer\u001b[37m]: ${options.message}`)

          break
        }
        case 'spotify': {
          if (options.type === 1 && config.debug.spotify.success)
            consoleLog(`[\u001b[32mspotify\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.spotify.error)
            consoleError(`[\u001b[31mspotify\u001b[37m]: ${options.message}`)

          break
        }
        case 'soundcloud': {
          if (options.type === 1 && config.debug.soundcloud.success)
            consoleLog(`[\u001b[32msoundcloud\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.soundcloud.error)
            consoleError(`[\u001b[31msoundcloud\u001b[37m]: ${options.message}`)

          break
        }
        case 'musixmatch': {
          consoleLog(`[\u001b[32mmusixmatch\u001b[37m]: ${options.message}`)

          break
        }
      }

      break
    }
    case 6: {
      if (!config.debug.request.all) return;

      if (options.headers) {
        options.headers.authorization = 'REDACTED'
        options.headers.host = 'REDACTED'
      }

      consoleLog(`[\u001b[32mALL\u001b[37m]: Received a request from client.\n Path: ${options.path}${options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

      break
    }
  }
}

export function sendResponse(req, res, data, status) {
  if (!data) {
    res.writeHead(status)
    res.end()

    return true
  }

  if (!req.headers || !req.headers['accept-encoding']) {
    res.setHeader('Connection', 'close')
    res.writeHead(status, { 'Content-Type': 'application/json' })

    res.end(JSON.stringify(data))
  }

  if (req.headers && req.headers['accept-encoding']) {
    if (req.headers['accept-encoding'].includes('br')) {
      res.setHeader('Content-Encoding', 'br')
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' })

      zlib.brotliCompress(JSON.stringify(data), (err, result) => {
        if (err) {
          res.writeHead(500)
          res.end()

          return;
        }

        res.end(result)
      })
    }

    else if (req.headers['accept-encoding'].includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip')
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
  
      zlib.gzip(JSON.stringify(data), (err, result) => {
        if (err) {
          res.writeHead(500)
          res.end()

          return;
        }

        res.end(result)
      })
    }

    else if (req.headers['accept-encoding'].includes('deflate')) {
      res.setHeader('Content-Encoding', 'deflate')
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' })
  
      zlib.deflate(JSON.stringify(data), (err, result) => {
        if (err) {
          res.writeHead(500)
          res.end()

          return;
        }

        res.end(result)
      })
    }
  }

  return true
}

export function tryParseBody(req, res) {
  return new Promise((resolve) => {
    let buffer = ''

    req.on('data', (chunk) => buffer += chunk)
    req.on('end', () => {
      try {
        resolve(JSON.parse(buffer))
      } catch {
        sendResponse(req, res, {
          timestamp: Date.now(),
          status: 400,
          trace: new Error().stack,
          error: 'Bad Request',
          message: 'Invalid JSON body',
          path: req.url
        }, 400)

        resolve(null)
      }
    })
  })
}

export function sendResponseNonNull(req, res, data) {
  if (data === null) return;

  sendResponse(req, res, data, 200)

  return true
}

export function verifyMethod(parsedUrl, req, res, expected) {
  if (req.method !== expected) {
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 405,
      error: 'Method Not Allowed',
      message: `Request method must be ${expected}`,
      path: parsedUrl.pathname
    }, 405)

    return 1
  }

  return 0
}

Array.prototype.nForEach = async function(callback) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < this.length; i++) {
      const res = await callback(this[i], i)

      if (res) return resolve()
    }

    resolve()
  })
}

export function waitForEvent(emitter, eventName, func, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = timeoutMs ? setTimeout(() => {
      throw new Error(`Event ${eventName} timed out after ${timeoutMs}ms`)
    }, timeoutMs) : null

    const listener = (param, param2) => {
      if (func(param, param2) === true) {
        emitter.removeListener(eventName, listener)
        timeoutMs ? clearTimeout(timeout) : null
        resolve()
      }
    }
    emitter.on(eventName, listener)
  })
}

export function clamp16Bit(sample) {
  return Math.max(constants.pcm.minimumRate, Math.min(sample, constants.pcm.maximumRate))
}

export function parseClientName(clientName) {
  if (!clientName)
    return null

  let clientInfo = clientName.split('(')
  if (clientInfo.length > 1) clientInfo = clientInfo[0].slice(0, clientInfo[0].length - 1)
  else clientInfo = clientInfo[0]

  const split = clientInfo.split('/')
  const name = split[0]
  const version = split[1]

  if (!name || !version || split.length != 2) return null

  return { name, version }
}

export function isEmpty(value) {
  return value === undefined || value === null || false
}

export function loadHLS(url, stream, onceEnded) {
  return new Promise(async (resolve) => {
    const response = await http1makeRequest(url, { method: 'GET' })
    const body = response.body.split('\n')

    body.nForEach(async (line, i) => {
      return new Promise(async (resolveSegment) => {
        if (stream.ended) {
          resolveSegment(true)

          return resolve(false)
        }

        if (line.startsWith('#')) {
          const tag = line.split(':')[0]

          if (tag === '#EXT-X-ENDLIST') {
            stream.end()

            return resolveSegment(true)
          }

          return resolveSegment(false)
        }

        const segment = await http1makeRequest(line, { method: 'GET', streamOnly: true })

        segment.stream.on('data', (chunk) => stream.write(chunk))

        segment.stream.on('end', () => {
          if (onceEnded && i === body.length - 2) {
            resolve(true)

            segment.stream.destroy()
          } else {
            resolveSegment(false)

            segment.stream.destroy()
          }
        })
      })
    })

    if (!onceEnded) resolve(true)
  })
}

export function loadHLSPlaylist(url, stream) {
  return new Promise(async (resolve) => {
    const response = await http1makeRequest(url, { method: 'GET' })
    const body = response.body.split('\n')
    body.pop()

    body.nForEach(async (line, i) => {
      return new Promise(async (resolvePlaylist) => {
        if (line.startsWith('#')) {
          const tag = line.split(':')[0]
          let value = line.split(':')[1]
          if (value) value = value.split(',')[0]

          if (tag === '#EXT-X-ENDLIST') {
            stream.end()

            resolvePlaylist(true)

            return resolve(stream)
          }

          resolvePlaylist(false)

          if (i === body.length - 1) {
            loadHLSPlaylist(value, stream)

            resolve(stream)
          }

          return;
        }

        if (await loadHLS(line, stream, true) === false)
          return resolve(stream)

        resolvePlaylist(false)

        if (i === body.length - 2) {
          loadHLSPlaylist(url, stream)

          return resolve(stream)
        }
      })
    })

    resolve(stream)
  })
}