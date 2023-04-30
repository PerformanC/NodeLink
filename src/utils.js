import https from 'https'
import http2 from 'http2'
import zlib from 'zlib'
import cp from 'child_process'
import fs from 'fs'
import { URL } from 'url'

import config from '../config.js'

function generateSessionId() {
  let result = ''
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  
  let counter = 0
  while (counter < 16) {
    result += characters.charAt(Math.floor(Math.random() * characters.length))
    counter++
  }
  
  return result
}

function http1makeRequest(url, options) {
  return new Promise(async (resolve, reject) => {
    let compression, data = ''

    const req = https.request(url, {
      method: options.method,
      headers: {
        'Accept-Encoding': 'br, gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0'
      }
    }, (res) => {
      if (options.retrieveHeaders) {
        req.destroy()

        return resolve(res.headers)
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
        res = compression
      }

      res.on('data', (chunk) => (data += chunk))

      res.on('end', () => resolve(JSON.parse(data.toString())))
    }).end()

    req.on('error', (error) => {
      console.error(`[NodeLink:makeRequest1]: Failed sending HTTP request: ${error}`)
      reject()
    })
  })
}

function makeRequest(url, options) {
  return new Promise(async (resolve, reject) => {
    let compression, data = '', parsedUrl = new URL(url)
    const client = http2.connect(parsedUrl.origin, { protocol: parsedUrl.protocol })

    let reqOptions = {
      ':method': options.method,
      ':path': parsedUrl.pathname + parsedUrl.search,
      'Accept-Encoding': 'br, gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0'
    }
    if (options.body && !options.disableBodyCompression) reqOptions['Content-Encoding'] = 'gzip'
    if (options.headers) reqOptions = { ...reqOptions, ...options.headers }

    let req = client.request(reqOptions)

    if (options.streamOnly)
      return resolve(req)

    req.on('error', (error) => {
      console.error(`[NodeLink:makeRequest]: Failed sending HTTP request: ${error}`)
      reject()
    })

    req.on('response', (headers) => {
      if (options.retrieveCookies) {
        req.destroy()

        return resolve(headers['set-cookie'])
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
        req = compression
      }

      req.on('data', (chunk) => data += chunk)

      req.on('end', () => {
        resolve(headers['content-type'].startsWith('application/json') ? JSON.parse(data.toString()) : data.toString())

        client.close()
      })
    })

    if (options.body) {
      if (options.disableBodyCompression)
        req.write(JSON.stringify(options.body), () => req.end())
      else zlib.gzip(JSON.stringify(options.body), (error, data) => {
        if (error) throw new Error(`[NodeLink:makeRequest]: Failed gziping body: ${error}`)
        req.write(data, () => req.end())
      })
    }
    else req.end()
  })
}

class EncodeClass {
  constructor() {
    this.position = 0
    this.buffer = Buffer.alloc(256)
  }

  changeBytes(bytes) {
    if (this.position + bytes > 252) {
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
    return this.buffer.slice(0, this.position)
  }
}

function encodeTrack(obj) {
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

function decodeTrack(track) {
  const buf = new DecodeClass(Buffer.from(track, 'base64'))

  const version = ((buf.read('int') & 0xC0000000) >> 30 & 1) !== 0 ? buf.read('byte') : 1

  switch (version) {
    case 1: {
      return {
        title: buf.read('utf'),
        author: buf.read('utf'),
        length: Number(buf.read('long')),
        identifier: buf.read('utf'),
        isStream: buf.read('byte') == 1,
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
        isStream: buf.read('byte') == 1,
        uri: buf.read('byte') == 1 ? buf.read('utf') : null,
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
        isStream: buf.read('byte') == 1,
        uri: buf.read('byte') == 1 ? buf.read('utf') : null,
        artworkUrl: buf.read('byte') == 1 ? buf.read('utf') : null,
        isrc: buf.read('byte') == 1 ? buf.read('utf') : null,
        sourceName: buf.read('utf'),
        position: Number(buf.read('long'))
      }
    }
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkForUpdates() {
  const version = `v${config.version}`

  let data

  try {
    data = await makeRequest(`https://api.github.com/repos/PerformanC/NodeLink/releases/latest`, { method: 'GET' })
  } catch (e) {
    console.log(`[NodeLink] Error while checking for updates: ${e}`)

    return;
  }

  if (data.message) {
    console.log(`[NodeLink] Error while checking for updates: ${data.message} (documentation: ${data.documentation_url})`)

    return;
  }

  if (data.name != version) {
    console.log(`[NodeLink] A new version of NodeLink is available! (${data.name})`)

    if (config.options.autoUpdate[0]) {
      console.log(`[NodeLink] Updating NodeLink, downloading ${config.options.autoUpdate[2]}...`)

      const res = await makeRequest(`https://codeload.github.com/PerformanC/NodeLink/legacy.${config.options.autoUpdate[2] == 'zip' || config.options.autoUpdate[2] == '7zip' ? 'zip' : 'tar.gz'}/refs/tags/${data.name}`, { method: 'GET', streamOnly: true })

      const file = fs.createWriteStream(`PerformanC-Nodelink.${config.options.autoUpdate[2] == '7zip' ? 'zip' : 'tar.gz' }`)
      res.pipe(file)

      file.on('finish', () => {
        file.close()

        const args = []
        if (config.options.autoUpdate[2] == 'zip') args.push([ 'PerformanC-Nodelink.zip' ])
        else if (config.options.autoUpdate[2] == '7zip') args.push([ 'x', 'PerformanC-Nodelink.zip' ])
        else args.push([ '-xvf', 'PerformanC-Nodelink.tar.gz' ])

        cp.spawn(config.options.autoUpdate[2] == 'zip' ? 'unzip' : config.options.autoUpdate[2] == '7zip' ? '7z' : 'tar', args, { shell: true }).on('close', () => {
          const move = cp.spawn(process.platform == 'win32' ? 'move' : 'mv', process.platform == 'win32' ? [ '"PerformanC-Nodelink*"', '".."'] : [ 'PerformanC-Nodelink*/*', '..', '-f' ], { shell: true })
          
          move.stdin.write('Y')
          move.on('close', () => {
            fs.rm('PerformanC-Nodelink.zip', { recursive: true, force: true }, () => {})

            console.log('[NodeLink] Nodelink has been updated, please restart NodeLink to apply the changes.')
          })
        })
      })
    }
  }
}

function debugLog(name, type, options) {
  switch (type) {
    case 1: {
      if (!config.debug.request.enabled) return;
      
      if (options.error)
        console.warn(`[NodeLink:${name}]: Detected an error in a request: ${options.error}`)
      else
        console.log(`[NodeLink:${name}]: Received a request from client.${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

      break
    }
    case 2: {
      switch (name) {
        case 'trackStart': {
          if (config.debug.track.start)
            console.log(`[NodeLink:trackStart]: Started playing ${options.track.title} by ${options.track.author} on ${options.guildId}.`)

            break
        }
        case 'trackEnd': {
          if (config.debug.track.end)
            console.log(`[NodeLink:trackEnd]: Ended playing ${options.track.title} by ${options.track.author} on ${options.guildId}, reason: ${options.reason}.`)

            break
        }
        case 'trackException': {
          if (config.debug.track.exception)
            console.warn(`[NodeLink:trackException]: An exception occurred while playing ${options.track.title} by ${options.track.author} on ${options.guildId}. (${options.exception.message})`)

            break
        }
        case 'trackStuck': {
          if (config.debug.track.stuck)
            console.warn(`[NodeLink:trackStuck]: ${config.options.threshold}ms have passed since the last progress update on ${options.guildId}.`)

            break
        }
      }

      break
    }
    case 3: {
      switch (name) {
        case 'connect': {
          if (!config.debug.websocket.connect) return;

          if (options.headers['client-name'])
            console.log(`[NodeLink:websocket]: "${options.headers['client-name']}" client connected to NodeLink.`)
          else
            console.log(`[NodeLink:websocket]: A client, which didn't specific its name, connected to NodeLink.`)

            break
        }
        case 'disconnect': {
          if (!config.debug.websocket.disconnect) return;

          console.log(`[NodeLink:websocket]: A connection was closed with a client.\n Code: ${options.code}\n Reason: ${options.reason == '' ? 'No reason provided' : options.reason})`)
        
          break
        }
        case 'resume': {
          if (!config.debug.websocket.resume) return;

          if (options.headers['client-name'])
            console.log(`[NodeLink:websocket]: "${options.headers['client-name']}" client resumed a connection to NodeLink.`)
          else
            console.log(`[NodeLink:websocket]: A client, which didn't specific its name, resumed a connection to NodeLink.`)

          break
        }

        case 'failedResume': {
          if (!config.debug.websocket.failedResume) return;

          if (options.headers['client-name'])
            console.log(`[NodeLink:websocket]: "${options.headers['client-name']}" client failed to resume a connection to NodeLink.`)
          else
            console.log(`[NodeLink:websocket]: A client, which didn't specific its name, failed to resume a connection to NodeLink.`)

          break
        }
      }

      break
    }
    case 4: {
      switch (name) {
        case 'loadtracks': {
          if (options.type == 1 && config.debug.sources.loadtrack.request)
            console.log(`[NodeLink:sources]: Loading ${options.loadType} from ${options.sourceName}: ${options.query}`)

          if (options.type == 2 && config.debug.sources.loadtrack.results) {
            if (options.tracksLen)
              console.log(`[NodeLink:sources]: Loaded ${options.tracksLen} tracks from ${options.sourceName}: ${options.query}`)
            else
              console.log(`[NodeLink:sources]: Loaded ${options.track.title} by ${options.track.author} from ${options.sourceName}: ${options.query}`)
          }

          if (options.type == 3 && config.debug.sources.loadtrack.exception)
            console.warn(`[NodeLink:sources]: An exception occurred while loading ${options.loadType} from ${options.sourceName}: ${options.message}`)

          break
        }
        case 'search': {
          if (options.type == 1 && config.debug.sources.search.request)
            console.log(`[NodeLink:sources]: Searching track on ${options.sourceName}: ${options.query}`)
          
          if (options.type == 2 && config.debug.sources.search.results)
            console.log(`[NodeLink:sources]: Found ${options.tracksLen} tracks on ${options.sourceName}: ${options.query}`)

          if (options.type == 3 && config.debug.sources.search.exception)
            console.warn(`[NodeLink:sources]: An exception occurred while searching on ${options.sourceName}: ${options.exception.message}`)

          break
        }
        case 'retrieveStream': {
          if (!config.debug.sources.retrieveStream) return;
          if (options.type == 1)
            console.log(`[NodeLink:sources]: Retrieving stream from ${options.sourceName}: ${options.query}`)

          if (options.type == 2)
            console.warn(`[NodeLink:sources]: Error while retrieving stream from ${options.sourceName}: ${options.message}`)
        }
      }

      break
    }
    case 5: {
      if (name == 'innertube' && config.debug.innertube)
        console.log(`[NodeLink:innertube]: ${options.message}`)

      if (name == 'pandora' && config.debug.pandoraInterval)
        console.log(`[NodeLink:pandora]: ${options.message}`)
    }
  }
}

function send(req, res, data, status) {
  if (req.headers['accept-encoding'] && req.headers['accept-encoding'].includes('br')) {
    res.setHeader('Content-Encoding', 'br')
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' })
    zlib.brotliCompress(JSON.stringify(data), (err, result) => {
      if (err) throw err
      res.end(result)
    })
    return true
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
}

function sendNonNull(req, res, data, force) {
  if (data == null && !force) return;

  send(req, res, data, 200)

  return true
}

export default {
  generateSessionId,
  http1makeRequest,
  makeRequest,
  encodeTrack,
  decodeTrack,
  sleep,
  checkForUpdates,
  debugLog,
  send,
  sendNonNull
}