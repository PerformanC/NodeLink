import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import cp from 'node:child_process'
import fs from 'node:fs'
import { URL } from 'node:url'

import config from '../config.js'

let updated = false

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

export function http1makeRequest(url, options) { 
  return new Promise(async (resolve, reject) => {
    let compression, data = ''

    const req = (url.startsWith('https') ? https : http).request(url, {
      method: options.method,
      headers: {
        'Accept-Encoding': 'br, gzip, deflate',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
        ...(options.headers || {})
      },
      rejectUnauthorized: false
    }, (res) => {
      if (res.statusCode == 401) throw new Error(`[\u001b[31mhttp1makeRequest\u001b[37m]: Received 401 in url: ${url}.`)

      if (options.retrieveHeaders) {
        req.destroy()

        return resolve(res.headers)
      }

      const isJson = res.headers['content-type'].startsWith('application/json')

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

      if (options.streamOnly)
        return resolve(res)

      res.on('data', (chunk) => (data += chunk))
      res.on('error', () => reject())
      res.on('end', () => resolve(isJson ? JSON.parse(data.toString()) : data.toString()))
    }).end()

    req.on('error', (error) => {
      console.error(`[\u001b[31mhttp1makeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

      reject(error)
    })
  })
}

export function makeRequest(url, options) {
  return new Promise(async (resolve, reject) => {
    let compression, data = '', parsedUrl = new URL(url)
    const client = http2.connect(parsedUrl.origin, { protocol: parsedUrl.protocol, rejectUnauthorized: false })

    let reqOptions = {
      ':method': options.method,
      ':path': parsedUrl.pathname + parsedUrl.search,
      'Accept-Encoding': 'br, gzip, deflate',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0'
    }
    if (options.body && !options.disableBodyCompression) reqOptions['Content-Encoding'] = 'gzip'
    if (options.headers) reqOptions = { ...reqOptions, ...options.headers }

    let req = client.request(reqOptions)

    req.on('error', (error) => {
      console.error(`[\u001b[31mmakeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

      reject(error)
    })

    req.on('response', (headers) => {
      if (options.cookiesOnly) {
        req.destroy()

        return resolve(headers['set-cookie'])
      }
      let cookie = headers['set-cookie']

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

      if (options.streamOnly)
        return resolve(req)

      req.on('data', (chunk) => data += chunk)
      req.on('error', (error) => reject(error))
      req.on('end', () => {
        client.close()

        if (options.getCookies) {
          resolve({
            cookies: cookie,
            body: headers['content-type'].startsWith('application/json') ? JSON.parse(data.toString()) : data.toString()
          })
        } else {
          resolve(headers['content-type'].startsWith('application/json') ? JSON.parse(data.toString()) : data.toString())
        }
      })
    })

    if (options.body) {
      if (options.disableBodyCompression)
        req.write(JSON.stringify(options.body), () => req.end())
      else zlib.gzip(JSON.stringify(options.body), (error, data) => {
        if (error) throw new Error(`\u001b[31mmakeRequest\u001b[37m]: Failed gziping body: ${error}`)
        req.write(data, () => req.end())
      })
    } else req.end()
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
  } catch {
    return null
  }
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function checkForUpdates() {
  if (updated) return;

  const version = `v${config.version.major}.${config.version.minor}.${config.version.patch}${config.version.preRelease ? `-${config.version.preRelease}` : ''}`

  console.log(`[\u001b[32mupdater\u001b[37m] Checking for updates in ${config.options.autoUpdate[0] ? 'beta' : 'stable'} releases...`)

  let data, selected

  if (config.options.autoUpdate[0]) {
    try {
      data = await makeRequest(`https://api.github.com/repos/PerformanC/NodeLink/releases`, { method: 'GET' })
    } catch (e) {
      console.error(`[\u001b[31mupdater\u001b[37m] HTTP error: ${e}`)

      return;
    }
  } else {
    try {
      data = await makeRequest(`https://api.github.com/repos/PerformanC/NodeLink/releases/latest`, { method: 'GET' })
    } catch (e) {
      console.error(`[\u001b[31mupdater\u001b[37m] HTTP error: ${e}`)

      return;
    }
  }

  if (data.message) {
    console.error(`[\u001b[31mupdater\u001b[37m] GitHub error: ${data.message} (documentation: ${data.documentation_url})`)

    return;
  }

  if (config.options.autoUpdate[0]) selected = data.find((e) => !e.prerelease)[0]
  else selected = data

  if (selected.name != version) {
    console.log(`[\u001b[33mupdater\u001b[37m] A new ${selected.prelease ? 'beta' : 'stable'} version of NodeLink is available! (${selected.name})`)

    if (config.options.autoUpdate[1]) {
      console.log(`[\u001b[32mupdater\u001b[37m] Updating NodeLink, downloading ${config.options.autoUpdate[3]}...`)

      const res = await makeRequest(`https://codeload.github.com/PerformanC/NodeLink/legacy.${config.options.autoUpdate[3] == 'zip' || config.options.autoUpdate[3] == '7zip' ? 'zip' : 'tar.gz'}/refs/tags/${selected.name}`, { method: 'GET', streamOnly: true })

      const file = fs.createWriteStream(`PerformanC-Nodelink.${config.options.autoUpdate[3] == '7zip' ? 'zip' : 'tar.gz' }`)
      res.pipe(file)

      file.on('finish', () => {
        file.close()

        const args = []
        if (config.options.autoUpdate[3] == 'zip') args.push('PerformanC-Nodelink.zip')
        else if (config.options.autoUpdate[3] == '7zip') args.push('x', 'PerformanC-Nodelink.zip')
        else args.push('-xvf', 'PerformanC-Nodelink.tar.gz')

        cp.spawn(config.options.autoUpdate[3] == 'zip' ? 'unzip' : config.options.autoUpdate[3] == '7zip' ? '7z' : 'tar', args, { shell: true }).on('close', () => {
          fs.readdir('.', (err, files) => {
            if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to read current directory: ${err}`)

            files.forEach((file) => {
              if (file.startsWith('PerformanC-NodeLink-')) {
                const moveFiles = cp.spawn(process.platform == 'win32' ? 'move' : 'mv', process.platform == 'win32' ? [ `"${file}"/*`, '"."', '-f' ] : [ `${file}/*`, '.', '-f' ], { shell: true })
                moveFiles.stdin.write('Y')

                moveFiles.on('close', () => {
                  fs.readdir(file, (err, subfiles) => {
                    if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to read ${file} directory: ${err}`)

                    subfiles.forEach((subfile) => {
                      fs.rm(`./${subfile}`, { recursive: true, force: true }, (err) => {
                        if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to remove ${subfile}: ${err}`)

                        const moveDirs = cp.spawn(process.platform == 'win32' ? 'move' : 'mv', process.platform == 'win32' ? [ `"${file}/${subfile}`, `"."`, '-f' ] : [ `${file}/${subfile}`, `.`, '-f' ], { shell: true })

                        moveDirs.stdin.write('Y')
                      })
                    })
                  })

                  fs.rm(`PerformanC-Nodelink.${config.options.autoUpdate[3] == '7zip' ? 'zip' : 'tar.gz' }`, { force: true }, () => {})
                  fs.rm(file, { recursive: true, force: true }, () => {})

                  updated = true

                  console.log('[\u001b[32mupdater\u001b[37m] Nodelink has been updated, please restart NodeLink to apply the changes.')
                })
              }
            })
          })
        })
      })

      res.end()
    }
  } else {
    console.log(`[\u001b[32mupdater\u001b[37m] NodeLink is up to date! (${version})`)
  }
}

export function debugLog(name, type, options) {
  switch (type) {
    case 1: {
      if (!config.debug.request.enabled) return;
      
      if (options.error)
        console.warn(`[\u001b[32m${name}\u001b[37m]: Detected an error in a request: \u001b[31m${options.error}\u001b[37m`)
      else
        console.log(`[\u001b[32m${name}\u001b[37m]: Received a request from client.${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

      break
    }
    case 2: {
      switch (name) {
        case 'trackStart': {
          if (config.debug.track.start)
            console.log(`[\u001b[32mtrackStart\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m.`)

            break
        }
        case 'trackEnd': {
          if (config.debug.track.end)
            console.log(`[\u001b[32mtrackEnd\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m because was \u001b[94m${options.reason}\u001b[37m.`)

            break
        }
        case 'trackException': {
          if (config.debug.track.exception)
            console.warn(`[\u001b[31mtrackException\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m: \u001b[31m${options.exception}\u001b[37m`)

            break
        }
        case 'trackStuck': {
          if (config.debug.track.stuck)
            console.warn(`[\u001b[33mtrackStuck\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m: [\u001b[33m${config.options.threshold}ms have passed.]\u001b[37m`)

            break
        }
      }

      break
    }
    case 3: {
      switch (name) {
        case 'connect': {
          if (!config.debug.websocket.connect) return;

          console.log(`[\u001b[32mwebsocket\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m client connected to NodeLink.`)

          break
        }
        case 'disconnect': {
          if (!config.debug.websocket.disconnect) return;

          console.log(`[\u001b[33mwebsocket\u001b[37m]: A connection was closed with a client.\n Code: \u001b[33m${options.code}\u001b[37m\n Reason: \u001b[33m${options.reason == '' ? 'No reason provided' : options.reason}\u001b[37m`)
        
          break
        }
        case 'resume': {
          if (!config.debug.websocket.resume) return;

          console.log(`[\u001b[32mwebsocket\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m client resumed a connection to NodeLink.`)

          break
        }

        case 'failedResume': {
          if (!config.debug.websocket.failedResume) return;

          console.log(`[\u001b[31mfailedResume[\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}"\u001b[37m failed to resume.`)

          break
        }

        case 'resumeTimeout': {
          if (!config.debug.websocket.resumeTimeout) return;

          console.log(`[\u001b[31mresumeTimeout\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m failed to resume in time.`)

          break
        }
      }

      break
    }
    case 4: {
      switch (name) {
        case 'loadtracks': {
          if (options.type == 1 && config.debug.sources.loadtrack.request)
            console.log(`[\u001b[32mloadTracks\u001b[37m]: Loading \u001b[94m${options.loadType}\u001b[37m from ${options.sourceName}: ${options.query}`)

          if (options.type == 2 && config.debug.sources.loadtrack.results) {
            if (options.loadType != 'search' && options.loadType != 'track')
              console.log(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.playlistName}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m.`)
            else
              console.log(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: ${options.query}`)
          }

          if (options.type == 3 && config.debug.sources.loadtrack.exception)
            console.warn(`[\u001b[31mloadTracks\u001b[37m]: Exception loading \u001b[94m${options.loadType}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'search': {
          if (options.type == 1 && config.debug.sources.search.request)
            console.log(`[\u001b[32msearch\u001b[37m]: Searching for \u001b[94m${options.query}\u001b[37m on \u001b[94m${options.sourceName}\u001b[37m`)
          
          if (options.type == 2 && config.debug.sources.search.results)
            console.log(`[\u001b[32msearch\u001b[37m]: Found \u001b[94m${options.tracksLen}\u001b[37m tracks on \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type == 3 && config.debug.sources.search.exception)
            console.warn(`[\u001b[31msearch\u001b[37m]: Exception from ${options.sourceName} for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'retrieveStream': {
          if (!config.debug.sources.retrieveStream) return;

          if (options.type == 1)
            console.log(`[\u001b[32mretrieveStream\u001b[37m]: Retrieved from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type == 2)
            console.warn(`[\u001b[31mretrieveStream\u001b[37m]: Exception from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'loadcaptions': {
          if (options.type == 1 && config.debug.sources.loadcaptions.request)
            console.log(`[\u001b[32mloadCaptions\u001b[37m]: Loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type == 2 && config.debug.sources.loadcaptions.results)
            console.log(`[\u001b[32mloadCaptions\u001b[37m]: Loaded captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type == 3 && config.debug.sources.loadcaptions.exception)
            console.warn(`[\u001b[31mloadCaptions\u001b[37m]: Exception loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
      }

      break
    }
    case 5: {
      switch (name) {
        case 'innertube': {
          if (options.type == 1 && config.debug.innertube.success)
            console.log(`[\u001b[32minnertube\u001b[37m]: ${options.message}`)

          if (options.type == 2 && config.debug.innertube.error)
            console.warn(`[\u001b[31minnertube\u001b[37m]: ${options.message}`)

          break
        }

        case 'pandora': {
          if (options.type == 1 && config.debug.pandora.success)
            console.log(`[\u001b[32mpandora\u001b[37m]: ${options.message}`)

          if (options.type == 2 && config.debug.pandora.error)
            console.warn(`[\u001b[31mpandora\u001b[37m]: ${options.message}`)

          break
        }

        case 'deezer': {
          if (options.type == 1 && config.debug.deezer.success)
            console.log(`[\u001b[32mdeezer\u001b[37m]: ${options.message}`)

          if (options.type == 2 && config.debug.deezer.error)
            console.warn(`[\u001b[31mdeezer\u001b[37m]: ${options.message}`)

          break
        }
      }
    }
  }
}

export function verifyMethod(parsedUrl, req, res, expected) {
  if (req.method != expected) {
    send(req, res, {
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

export function sendResponse(req, res, data, status) {
  if (req.headers && req.headers['accept-encoding'] && req.headers['accept-encoding'].includes('br')) {
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

export function sendResponseNonNull(req, res, data) {
  if (data == null) return;

  sendResponse(req, res, data, 200)

  return true
}