import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import cp from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'

import config from '../config.js'
import constants from '../constants.js'

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
      if (options.disableBodyCompression)
        req.end(JSON.stringify(options.body))
      else zlib.gzip(JSON.stringify(options.body), (error, data) => {
        if (error) throw new Error(`\u001b[31mhttp1makeRequest\u001b[37m]: Failed gziping body: ${error}`)
        req.end(data)
      })
    } else req.end()

    req.on('error', (error) => {
      console.error(`[\u001b[31mhttp1makeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

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

    req.on('error', (error) => {
      console.error(`[\u001b[31mmakeRequest\u001b[37m]: Failed sending HTTP request to ${url}: \u001b[31m${error}\u001b[37m`)

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

export async function checkForUpdates() {
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

  data = data.body

  if (data.message) {
    console.error(`[\u001b[31mupdater\u001b[37m] GitHub error: ${data.message} (documentation: ${data.documentation_url})`)

    return;
  }

  if (config.options.autoUpdate[0]) selected = data.find((e) => !e.prerelease)[0]
  else selected = data

  if (selected.name !== version) {
    const newVersion = selected.name.match(/v(\d+)\.(\d+)\.(\d+)-?(\w+)?/)

    if (
      (newVersion[1] < config.version.major) ||
      (newVersion[1] === config.version.major && newVersion[2] < config.version.minor) ||
      (newVersion[1] === config.version.major && newVersion[2] === config.version.minor && newVersion[3] < config.version.patch) ||
      (newVersion[1] === config.version.major && newVersion[2] === config.version.minor && newVersion[3] === config.version.patch && newVersion[4] === config.version.preRelease)
    ) {
      console.log(`[\u001b[32mupdater\u001b[37m] NodeLink is newer than latest! (${version} > ${selected.name})`)

      return;
    }

    config.version = {
      major: newVersion[1],
      minor: newVersion[2],
      patch: newVersion[3],
      preRelease: newVersion[4]
    }

    console.log(`[\u001b[33mupdater\u001b[37m] A new ${selected.prelease ? 'beta' : 'stable'} version of NodeLink is available! (${selected.name})`)

    if (config.options.autoUpdate[1]) {
      console.log(`[\u001b[32mupdater\u001b[37m] Updating NodeLink, downloading ${config.options.autoUpdate[3]}...`)

      const res = await makeRequest(`https://codeload.github.com/PerformanC/NodeLink/legacy.${config.options.autoUpdate[3] === 'zip' || config.options.autoUpdate[3] === '7zip' ? 'zip' : 'tar.gz'}/refs/tags/${selected.name}`, { method: 'GET', streamOnly: true })
      const filename = 'PerformanC-NodeLink-' + res.headers['content-disposition'].match(/-0-g(\w+).(tar.gz|7zip|zip)/)[1]

      const file = fs.createWriteStream(`PerformanC-Nodelink.${config.options.autoUpdate[3] === '7zip' ? 'zip' : 'tar.gz' }`)
      res.stream.pipe(file)

      file.on('finish', () => {
        file.close()

        const args = []
        if (config.options.autoUpdate[3] === 'zip') args.push('PerformanC-Nodelink.zip')
        else if (config.options.autoUpdate[3] === '7zip') args.push('x', 'PerformanC-Nodelink.zip')
        else args.push('-xvf', 'PerformanC-Nodelink.tar.gz')

        cp.spawn(config.options.autoUpdate[3] === 'zip' ? 'unzip' : config.options.autoUpdate[3] === '7zip' ? '7z' : 'tar', args, { shell: true }).on('close', () => {
          fs.readdir('.', (err, files) => {
            if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to read ${filename} directory: ${err}`)

            for (const folder of files) {
              if (folder !== filename && folder !== 'node_modules' && (folder === '.github' || !folder.startsWith('.')))
                fs.rmSync(folder, { recursive: true, force: true })
            }

            const moveFiles = cp.spawn(process.platform === 'win32' ? 'move' : 'mv', process.platform === 'win32' ? [ `"${filename}/*"`, `"."`, '-f' ] : [ `${filename}/*`, `.`, '-f' ], { shell: true })
            cp.spawn(process.platform === 'win32' ? 'move' : 'mv', process.platform === 'win32' ? [ `"${filename}/.github"`, `"."`, '-f' ] : [ `${filename}/.github`, `.`, '-f' ], { shell: true })

            moveFiles.on('close', () => {
              fs.rm(filename, { recursive: true, force: true }, () => {})

              fs.readFile('./config.js', (err, data) => {
                if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to read config.js: ${err}`)

                const sanitizedJson = data.toString().split('export default ')[1].replace(/'/g, '"').replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, "$1\"$2\":")
                let newJson = JSON.parse(sanitizedJson)

                newJson.server = {
                  ...newJson.server,
                  port: config.server.port,
                  password: config.server.password,
                  resumeTimeout: config.options.resumeTimeout
                }

                newJson.options = {
                  ...newJson.options,
                  threshold: config.options.threshold,
                  playerUpdateInterval: config.options.playerUpdateInterval,
                  statsInterval: config.options.statsInterval,
                  autoUpdate: config.options.autoUpdate,
                  maxResultsLength: config.options.maxResultsLength,
                  maxAlbumPlaylistLength: config.options.maxAlbumPlaylistLength
                }

                newJson.search = {
                  ...newJson.search,
                  defaultSearchSource: config.search.defaultSearchSource,
                  sources: {
                    ...newJson.search.sources,
                    youtube: config.search.sources.youtube,
                    youtubeMusic: config.search.sources.youtubeMusic,
                    spotify: config.search.sources.spotify,
                    bandcamp: config.search.sources.bandcamp,
                    http: config.search.sources.http,
                    local: config.search.sources.local,
                    pandora: config.search.sources.pandora,
                    deezer: {
                      ...newJson.search.sources.deezer,
                      enabled: config.search.sources.deezer.enabled,
                      decryptionKey: config.search.sources.deezer.decryptionKey,
                      urlEncryptionKey: config.search.sources.deezer.urlEncryptionKey,
                      apiKey: config.search.sources.deezer.apiKey
                    },
                    soundcloud: {
                      ...newJson.search.sources.soundcloud,
                      enabled: config.search.sources.soundcloud.enabled,
                      clientId: config.search.sources.soundcloud.clientId
                    }
                  }
                }

                newJson.filters = {
                  ...newJson.filters,
                  enabled: config.filters.enabled,
                  threads: config.filters.threads,
                  list: {
                    ...newJson.filters.list,
                    volume: config.filters.list.volume,
                    equalizer: config.filters.list.equalizer,
                    karaoke: config.filters.list.karaoke,
                    timescale: config.filters.list.timescale,
                    tremolo: config.filters.list.tremolo,
                    vibrato: config.filters.list.vibrato,
                    rotation: config.filters.list.rotation,
                    distortion: config.filters.list.distortion,
                    channelMix: config.filters.list.channelMix,
                    lowPass: config.filters.list.lowPass
                  }
                }

                newJson.audio = {
                  ...newJson.audio,
                  quality: config.audio.quality
                }

                fs.writeFile('./config.js', 'export default ' + JSON.stringify(newJson, null, 2), (err) => {
                  if (err) throw new Error(`[\u001b[31mupdater\u001b[37m] Failed to write to config.js: ${err}`)

                  console.log('[\u001b[32mupdater\u001b[37m] Nodelink has been updated, please restart NodeLink to apply the changes.')
                })
              })

              console.log('[\u001b[32mupdater\u001b[37m] Nodelink has been updated, please restart NodeLink to apply the changes.')
            })
          })
        })
      })

      res.stream.end()
    }
  } else {
    console.log(`[\u001b[32mupdater\u001b[37m] NodeLink is up to date! (${version})`)
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
        console.error(`[\u001b[32m${name}\u001b[37m]: Detected an error in a request: \u001b[31m${options.error}\u001b[37m${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)
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
            console.error(`[\u001b[31mtrackException\u001b[37m]: \u001b[94m${options.track?.title || 'None'}\u001b[37m by \u001b[94m${options.track?.author || 'none'}\u001b[37m: \u001b[31m${options.exception}\u001b[37m`)

            break
        }
        case 'trackStuck': {
          if (config.debug.track.stuck)
            console.warn(`[\u001b[33mtrackStuck\u001b[37m]: \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m: \u001b[33m${config.options.threshold}ms have passed.\u001b[37m`)

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

          console.error(`[\u001b[33mwebsocket\u001b[37m]: A connection was closed with a client.\n Code: \u001b[33m${options.code}\u001b[37m\n Reason: \u001b[33m${options.reason === '' ? 'No reason provided' : options.reason}\u001b[37m`)
        
          break
        }
        case 'resume': {
          if (!config.debug.websocket.resume) return;

          console.log(`[\u001b[32mwebsocket\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m client resumed a connection to NodeLink.`)

          break
        }
        case 'failedResume': {
          if (!config.debug.websocket.failedResume) return;

          console.error(`[\u001b[31mfailedResume[\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}"\u001b[37m failed to resume.`)

          break
        }
        case 'resumeTimeout': {
          if (!config.debug.websocket.resumeTimeout) return;

          console.log(`[\u001b[31mresumeTimeout\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m failed to resume in time.`)

          break
        }
        case 'error': {
          if (!config.debug.websocket.error) return;

          console.error(`[\u001b[31mwebsocketError\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m: \u001b[31m${options.error}\u001b[37m`)

          break
        }
        case 'connectCD': {
          if (!config.debug.websocket.connectCD) return;

          console.log(`[\u001b[32mwebsocketCD\u001b[37m]: \u001b[94m${options.headers['client-name'] || 'Unknown'}\u001b[37m client connected to NodeLink.\n Guild: \u001b[94m${options.guildId}\u001b[37m`)

          break
        }
        case 'disconnectCD': {
          if (!config.debug.websocket.disconnectCD) return;

          console.error(`[\u001b[32mwebsocketCD\u001b[37m]: A connection was closed with a client.\n Guild: \u001b[94m${options.guildId}\u001b[37m\n Code: \u001b[33m${options.code}\u001b[37m\n Reason: \u001b[33m${options.reason === '' ? 'No reason provided' : options.reason}\u001b[37m`)

          break
        }
        case 'sentDataCD': {
          if (!config.debug.websocket.sentDataCD) return;

          console.log(`[\u001b[32msentData\u001b[37m]: Sent data to \u001b[94m${options.clientsAmount}\u001b[37m clients.\n Guild: \u001b[94m${options.guildId}\u001b[37m`)

          break
        }
        default: {
          if (!config.debug.request.error) return;

          console.error(`[\u001b[31m${name}\u001b[37m]: \u001b[31m${options.error}\u001b[37m${config.debug.request.showParams && options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${config.debug.request.showHeaders && options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${config.debug.request.showBody && options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

          break
        }
      }

      break
    }
    case 4: {
      switch (name) {
        case 'loadtracks': {
          if (options.type === 1 && config.debug.sources.loadtrack.request)
            console.log(`[\u001b[32mloadTracks\u001b[37m]: Loading \u001b[94m${options.loadType}\u001b[37m from ${options.sourceName}: ${options.query}`)

          if (options.type === 2 && config.debug.sources.loadtrack.results) {
            if (options.loadType !== 'search' && options.loadType !== 'track')
              console.log(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.playlistName}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m.`)
            else
              console.log(`[\u001b[32mloadTracks\u001b[37m]: Loaded \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: ${options.query}`)
          }

          if (options.type === 3 && config.debug.sources.loadtrack.exception)
            console.error(`[\u001b[31mloadTracks\u001b[37m]: Exception loading \u001b[94m${options.loadType}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'search': {
          if (options.type === 1 && config.debug.sources.search.request)
            console.log(`[\u001b[32msearch\u001b[37m]: Searching for \u001b[94m${options.query}\u001b[37m on \u001b[94m${options.sourceName}\u001b[37m`)
          
          if (options.type === 2 && config.debug.sources.search.results)
            console.log(`[\u001b[32msearch\u001b[37m]: Found \u001b[94m${options.tracksLen}\u001b[37m tracks on \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type === 3 && config.debug.sources.search.exception)
            console.error(`[\u001b[31msearch\u001b[37m]: Exception from ${options.sourceName} for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'retrieveStream': {
          if (!config.debug.sources.retrieveStream) return;

          if (options.type === 1)
            console.log(`[\u001b[32mretrieveStream\u001b[37m]: Retrieved from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m`)

          if (options.type === 2)
            console.error(`[\u001b[31mretrieveStream\u001b[37m]: Exception from \u001b[94m${options.sourceName}\u001b[37m for query \u001b[94m${options.query}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
        case 'loadlyrics': {
          if (options.type === 1 && config.debug.sources.loadlyrics.request)
            console.log(`[\u001b[32mloadCaptions\u001b[37m]: Loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type === 2 && config.debug.sources.loadlyrics.results)
            console.log(`[\u001b[32mloadCaptions\u001b[37m]: Loaded captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m`)

          if (options.type === 3 && config.debug.sources.loadlyrics.exception)
            console.error(`[\u001b[31mloadCaptions\u001b[37m]: Exception loading captions for \u001b[94m${options.track.title}\u001b[37m by \u001b[94m${options.track.author}\u001b[37m from \u001b[94m${options.sourceName}\u001b[37m: \u001b[31m${options.message}\u001b[37m`)

          break
        }
      }

      break
    }
    case 5: {
      switch (name) {
        case 'youtube': {
          if (options.type === 1 && config.debug.youtube.success)
            console.log(`[\u001b[32myoutube\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.youtube.error)
            console.error(`[\u001b[31myoutube\u001b[37m]: ${options.message}`)

          break
        }

        case 'pandora': {
          if (options.type === 1 && config.debug.pandora.success)
            console.log(`[\u001b[32mpandora\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.pandora.error)
            console.error(`[\u001b[31mpandora\u001b[37m]: ${options.message}`)

          break
        }
        case 'deezer': {
          if (options.type === 1 && config.debug.deezer.success)
            console.log(`[\u001b[32mdeezer\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.deezer.error)
            console.error(`[\u001b[31mdeezer\u001b[37m]: ${options.message}`)

          break
        }
        case 'spotify': {
          if (options.type === 1 && config.debug.spotify.success)
            console.log(`[\u001b[32mspotify\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.spotify.error)
            console.error(`[\u001b[31mspotify\u001b[37m]: ${options.message}`)

          break
        }
        case 'soundcloud': {
          if (options.type === 1 && config.debug.soundcloud.success)
            console.log(`[\u001b[32msoundcloud\u001b[37m]: ${options.message}`)

          if (options.type === 2 && config.debug.soundcloud.error)
            console.error(`[\u001b[31msoundcloud\u001b[37m]: ${options.message}`)

          break
        }
        case 'musixmatch': {
          console.log(`[\u001b[32mmusixmatch\u001b[37m]: ${options.message}`)

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

      console.log(`[\u001b[32mALL\u001b[37m]: Received a request from client.\n Path: ${options.path}${options.params ? `\n Params: ${JSON.stringify(options.params)}` : ''}${options.headers ? `\n Headers: ${JSON.stringify(options.headers)}` : ''}${options.body ? `\n Body: ${JSON.stringify(options.body)}` : ''}`)

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
      res.setHeader('Connection', 'close')
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
      res.setHeader('Connection', 'close')
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
      res.setHeader('Connection', 'close')
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

export function tryParseBody(req, res, body) {
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