import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { URL } from 'node:url'
import util from 'node:util'
import zlib from 'node:zlib'

import packageJson from '../package.json' with { type: 'json' }
import {
  DEFAULT_MAX_REDIRECTS,
  DISCORD_ID_REGEX,
  HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT,
  REDIRECT_STATUS_CODES,
  SEMVER_PATTERN
} from './constants.js'

let loggingConfig = {}
const logLevels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}
let currentLogLevel = logLevels.info
let logStream = null
let gitInfoCache = null
let currentLogFile = null
let logRotationInterval = null
let logCleanupInterval = null

function getLogFileName() {
  const now = new Date()
  const rotation = loggingConfig.file?.rotation || 'session'

  if (rotation === 'hourly') {
    const date = now.toISOString().slice(0, 13).replace(/[:.]/g, '-')
    return `nodelink-${date}.log`
  }

  if (rotation === 'daily') {
    const date = now.toISOString().slice(0, 10)
    return `nodelink-${date}.log`
  }

  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  const randomId = crypto.randomBytes(4).toString('hex')
  return `nodelink-${timestamp}-${randomId}.log`
}

function cleanOldLogs() {
  if (!loggingConfig.file?.enabled) return

  const logDir = loggingConfig.file.path || 'logs'
  const ttlDays = loggingConfig.file.ttlDays || 7
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000
  const now = Date.now()

  try {
    if (!fs.existsSync(logDir)) return

    const files = fs.readdirSync(logDir)
    let cleanedCount = 0

    for (const file of files) {
      if (!file.startsWith('nodelink-') || !file.endsWith('.log')) continue

      const filePath = path.join(logDir, file)
      const stats = fs.statSync(filePath)
      const fileAge = now - stats.mtimeMs

      if (fileAge > ttlMs) {
        fs.unlinkSync(filePath)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      console.log(
        `[${new Date().toISOString().slice(11, 23)}] \x1b[1m\x1b[3;42m[INFO] >\x1b[0m: Logs > Cleaned ${cleanedCount} old log files`
      )
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString().slice(11, 23)}] \x1b[1m\x1b[3;41m[ERROR] >\x1b[0m: Logs > Failed to clean old logs: ${error.message}`
    )
  }
}

function rotateLogFile() {
  if (!loggingConfig.file?.enabled) return

  const logDir = loggingConfig.file.path || 'logs'
  const newLogFileName = getLogFileName()
  const newLogFilePath = path.join(logDir, newLogFileName)

  if (currentLogFile === newLogFilePath) return

  if (logStream) {
    logStream.end()
    logStream = null
  }

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  currentLogFile = newLogFilePath
  logStream = fs.createWriteStream(currentLogFile, { flags: 'a' })

  const gitInfo = getGitInfo()
  const version = getVersion()
  const initialInfo = `\n--- NodeLink Log ---\nTimestamp: ${new Date().toISOString()}\nVersion: ${version}\nGit Branch: ${gitInfo.branch}\nGit Commit: ${gitInfo.commit}\nOS: ${os.platform()} ${os.release()}\nNode.js: ${process.version}\n--------------------\n`
  logStream.write(initialInfo)
}

function initFileLogger() {
  if (!loggingConfig.file?.enabled) return

  rotateLogFile()

  const rotation = loggingConfig.file?.rotation || 'session'

  if (rotation === 'hourly') {
    logRotationInterval = setInterval(rotateLogFile, 60 * 60 * 1000)
  } else if (rotation === 'daily') {
    logRotationInterval = setInterval(rotateLogFile, 24 * 60 * 60 * 1000)
  }

  cleanOldLogs()

  logCleanupInterval = setInterval(cleanOldLogs, 60 * 60 * 1000)
}

function initLogger(config) {
  loggingConfig = config.logging || {}
  currentLogLevel = logLevels[loggingConfig.level || 'info']
  initFileLogger()
}

function logger(level, ...args) {
  const effectiveLevel =
    level === 'sources' || level === 'started' || level === 'network'
      ? 'info'
      : level
  const levelIndex = logLevels[effectiveLevel]

  if (levelIndex === undefined || levelIndex < currentLogLevel) return

  const category = args.length > 1 ? args[0] : ''

  if (level === 'debug') {
    const debugConfig = loggingConfig.debug || {}
    if (!debugConfig.all && !debugConfig[category]) {
      return
    }
  }

  const levels = {
    info: { label: 'INFO', color: '\x1b[1m\x1b[3;42m' },
    warn: { label: 'WARN', color: '\x1b[1m\x1b[3;43m' },
    error: { label: 'ERROR', color: '\x1b[1m\x1b[3;41m' },
    debug: { label: 'DEBUG', color: '\x1b[1m\x1b[3;45m' },
    sources: { label: 'SOURCES', color: '\x1b[1m\x1b[3;46m' },
    started: { label: 'STARTED', color: '\x1b[1m\x1b[3;44m' },
    network: { label: 'NETWORK', color: '\x1b[1m\x1b[3;44m' }
  }

  const resetColor = '\x1b[0m'
  const time = new Date().toISOString().slice(11, 23)
  const lvl = levels[level] || { label: level.toUpperCase(), color: '' }
  const formattedCategory = category ? `: ${category} >` : ''

  const messageArgs = args.length > 1 ? args.slice(1) : args
  const formattedArgs = messageArgs.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.stack || arg.message}`
    }
    if (typeof arg === 'object' && arg !== null) {
      return util.inspect(arg, { depth: null, colors: false })
    }
    return arg
  })

  const msg = util.format(...formattedArgs)

  const consoleOutput = `[${time}] ${lvl.color}[${lvl.label}] >${resetColor}${formattedCategory} ${msg}`
  console.log(consoleOutput)

  if (logStream) {
    const fileOutput = `[${new Date().toISOString()}] [${lvl.label}] ${formattedCategory} ${msg}\n`
    logStream.write(fileOutput)
  }
}

const verifyDiscordID = (id) => DISCORD_ID_REGEX.test(String(id))

function validateProperty({ value, path, expected, validator }) {
  if (value === undefined || value === null) {
    throw new Error(
      `Configuration error:\n` +
      `- Property: ${path}\n` +
      `- Problem: missing required value\n` +
      `- Expected: ${expected}\n\n` +
      `Please define ${path} in your config.js file.`
    )
  }

  if (!validator(value)) {
    throw new Error(
      `Configuration error:\n` +
      `- Property: ${path}\n` +
      `- Received: ${JSON.stringify(value)} (${typeof value})\n` +
      `- Expected: ${expected}`
    )
  }
}


function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version)
  if (!match) return null
  const { major, minor, patch, prerelease, build } = match.groups
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
    build: build ? build.split('.') : []
  }
}

function getVersion(type = 'string') {
  if (type === 'object') {
    return parseSemver(packageJson.version)
  }
  if (type === 'string') {
    return packageJson.version
  }
}

function sendResponse(req, res, data, status, trace = false) {
  const headers = {}

  if (!data) {
    res.writeHead(status, headers)
    res.end()
    return
  }

  let finalData = data
  if (data.trace && !trace) {
    const { trace: _, ...rest } = data
    finalData = rest
  }

  headers['Content-Type'] = 'application/json'
  const jsonData = JSON.stringify(finalData)
  const buffer = Buffer.from(jsonData)
  const encoding = req.headers['accept-encoding'] || ''

  if (process.isBun) {
    headers['Content-Length'] = buffer.byteLength
    res.writeHead(status, headers)
    res.end(buffer)
    return
  }

  const compressions = [
    { type: 'br', method: zlib.brotliCompress },
    { type: 'gzip', method: zlib.gzip },
    { type: 'deflate', method: zlib.deflate }
  ]

  for (const { type, method } of compressions) {
    if (encoding.includes(type)) {
      headers['Content-Encoding'] = type
      method(buffer, (err, result) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Compression failed' }))
          return
        }
        if (process.isBun) {
          headers['Content-Length'] = result.byteLength
        }
        res.writeHead(status, headers)
        res.end(result)
      })
      return
    }
  }

  headers['Content-Length'] = buffer.byteLength
  res.writeHead(status, headers)
  res.end(buffer)
}

function getGitInfo() {
  const isBun = typeof Bun !== 'undefined' && !!process.versions.bun
  // bun is too weird
  if (isBun) {
    logger('info', 'Git', 'Skipping update check (compiled build).')
    return {
      branch: 'unknown',
      commit: 'unknown',
      commitTime: -1
    }
  }

  if (gitInfoCache) return gitInfoCache

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8'
    }).trim()
    const commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8'
    }).trim()
    const commitTime =
      Number.parseInt(
        execSync('git log -1 --format=%ct', { encoding: 'utf8' }).trim(),
        10
      ) * 1000

    gitInfoCache = {
      branch,
      commit,
      commitTime
    }
    return gitInfoCache
  } catch (error) {
    logger(
      'warn',
      'Git',
      'Unable to retrieve git information. %s',
      error.message
    )
    gitInfoCache = {
      branch: 'unknown',
      commit: 'unknown',
      commitTime: -1
    }
    return gitInfoCache
  }
}

function getStats(nodelink) {
  let players = 0
  let playingPlayers = 0
  let aggregatedNodelinkLoad = 0
  const memory = {
    free: os.freemem(),
    used: 0,
    allocated: 0,
    reservable: os.totalmem()
  }

  if (nodelink.workerManager) {
    for (const stats of nodelink.workerManager.workerStats.values()) {
      players += stats.players || 0
      playingPlayers += stats.playingPlayers || 0
      if (stats.memory) {
        memory.used += stats.memory.used || 0
        memory.allocated += stats.memory.allocated || 0
      }
      if (stats.cpu) {
        aggregatedNodelinkLoad += stats.cpu.nodelinkLoad || 0
      }
    }
    const primaryMem = process.memoryUsage()
    memory.used += primaryMem.heapUsed
    memory.allocated += primaryMem.heapTotal
  } else {
    players = nodelink.statistics.players
    playingPlayers = nodelink.statistics.playingPlayers
    const mem = process.memoryUsage()
    memory.used = mem.heapUsed
    memory.allocated = mem.heapTotal
  }

  let frameStats = null
  if (players > 0) {
    frameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 }
    if (nodelink.workerManager) { 
      for (const workerStats of nodelink.workerManager.workerStats.values()) {
        if (workerStats.frameStats) {
          frameStats.sent += workerStats.frameStats.sent || 0
          frameStats.nulled += workerStats.frameStats.nulled || 0
          frameStats.expected += workerStats.frameStats.expected || 0
        }
      }
      frameStats.deficit = Math.max(0, frameStats.expected - frameStats.sent)
    } else { 
      for (const session of nodelink.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          if (!player.connection) continue
          const sent = player.connection.statistics.packetsSent || 0
          const nulled = player.connection.statistics.packetsLost || 0
          const expectedFrames =
            player.connection.statistics.packetsExpected || 0
          frameStats.sent += sent
          frameStats.nulled += nulled
          frameStats.expected += expectedFrames
        }
      }
      frameStats.deficit = Math.max(0, frameStats.expected - frameStats.sent)
    }
  }

  const uptime = Math.floor(process.uptime() * 1000)
  const cores = os.cpus().length
  const load = os.loadavg()[0]
  const cpu = {
    cores,
    systemLoad: load,
    nodelinkLoad: Number.parseFloat((aggregatedNodelinkLoad / cores).toFixed(2))
  }

  if (nodelink.routePlanner && nodelink.statsManager) {
    const availableIps = nodelink.routePlanner.ipBlocks?.length || 0
    const bannedIps = nodelink.routePlanner.bannedIps?.size || 0
    nodelink.statsManager.setRoutePlannerIps(availableIps, bannedIps)
  }

  return {
    players,
    playingPlayers,
    uptime,
    memory,
    cpu,
    frameStats
  }
}

function verifyMethod(
  parsedUrl,
  req,
  res,
  expected,
  clientAddress,
  trace = false
) {
  const methods = Array.isArray(expected) ? expected : [expected]
  // biome-ignore format: off
  if (!methods.includes(req.method)) {
    logger(
      'warn',
      'Server',
      `Method not allowed: ${req.method} ${parsedUrl.pathname} from ${clientAddress}`
    )
    sendResponse(req, res, {
        timestamp: Date.now(),
        status: 405,
        error: 'Method Not Allowed',
        message: `Method must be one of ${methods.join(', ')}`,
        path: parsedUrl.pathname,
        trace: new Error().stack
      }, 405, trace)
    return false
  }
  return true
}

function decodeTrack(encoded) {
  const buffer = Buffer.from(encoded, 'base64')
  let position = 0

  const read = {
    byte: () => buffer[position++],
    ushort: () => {
      const value = buffer.readUInt16BE(position)
      position += 2
      return value
    },
    int: () => {
      const value = buffer.readInt32BE(position)
      position += 4
      return value
    },
    long: () => {
      const value = buffer.readBigInt64BE(position)
      position += 8
      return value
    },
    utf: () => {
      const length = read.ushort()
      const value = buffer.toString('utf8', position, position + length)
      position += length
      return value
    }
  }

  const firstInt = read.int()
  const isVersioned = ((firstInt & 0xc0000000) >> 30) & 1
  const version = isVersioned ? read.byte() : 1

  return {
    encoded: encoded,
    info: {
      title: read.utf(),
      author: read.utf(),
      length: Number(read.long()),
      identifier: read.utf(),
      isSeekable: true,
      isStream: !!read.byte(),
      uri: version >= 2 && read.byte() ? read.utf() : null,
      artworkUrl: version === 3 && read.byte() ? read.utf() : null,
      isrc: version === 3 && read.byte() ? read.utf() : null,
      sourceName: read.utf(),
      position: Number(read.long())
    },
    pluginInfo: {},
    userData: {}
  }
}

function encodeTrack(track) {
  const bufferArray = []

  function write(type, value) {
    if (type === 'byte') bufferArray.push(Buffer.from([value]))
    if (type === 'ushort') {
      const buf = Buffer.alloc(2)
      buf.writeUInt16BE(value)
      bufferArray.push(buf)
    }
    if (type === 'int') {
      const buf = Buffer.alloc(4)
      buf.writeInt32BE(value)
      bufferArray.push(buf)
    }
    if (type === 'long') {
      const buf = Buffer.alloc(8)
      buf.writeBigInt64BE(BigInt(value))
      bufferArray.push(buf)
    }
    if (type === 'utf') {
      const strBuf = Buffer.from(value, 'utf8')
      write('ushort', strBuf.length)
      bufferArray.push(strBuf)
    }
  }

  const version = track.artworkUrl || track.isrc ? 3 : track.uri ? 2 : 1

  const isVersioned = version > 1 ? 1 : 0
  const firstInt = isVersioned << 30
  write('int', firstInt)

  if (isVersioned) {
    write('byte', version)
  }

  write('utf', track.title)
  write('utf', track.author)
  write('long', track.length)
  write('utf', track.identifier)
  write('byte', track.isStream ? 1 : 0)

  if (version >= 2) {
    write('byte', track.uri ? 1 : 0)
    if (track.uri) write('utf', track.uri)
  }

  if (version === 3) {
    write('byte', track.artworkUrl ? 1 : 0)
    if (track.artworkUrl) write('utf', track.artworkUrl)

    write('byte', track.isrc ? 1 : 0)
    if (track.isrc) write('utf', track.isrc)
  }

  write('utf', track.sourceName)
  write('long', track.position)

  return Buffer.concat(bufferArray).toString('base64')
}

const generateRandomLetters = (l) =>
  Array.from(crypto.randomBytes(l), (b) =>
    String.fromCharCode((b % 52) + (b % 52 < 26 ? 65 : 71))
  ).join('')

function parseClient(agent) {
  if (typeof agent !== 'string' || !agent.trim()) return null

  const [core, metaPart] = agent.trim().split(' ', 2)
  const [name, version] = core.split('/')
  if (!name) return null

  const info = { name }
  if (version) info.version = version
  // biome-ignore lint: uses-unsafe-optional-chaining
  if (metaPart && metaPart.startsWith('(') && metaPart.endsWith(')')) {
    const meta = metaPart.slice(1, -1)
    if (meta.startsWith('http')) {
      info.url = meta
    } else {
      const [tag, date] = meta.split('/')
      if (tag) info.codename = tag
      if (date) info.releaseDate = date
    }
  }

  return info
}

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })
const http2FailedHosts = new Set()

async function _internalHttp1Request(urlString, options = {}) {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeout = Math.max(1, options.timeout ?? 30000),
    streamOnly = false,
    disableBodyCompression = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    localAddress,
    agent: customAgent,
    _redirectsFollowed = 0
  } = options

  if (_redirectsFollowed >= maxRedirects) {
    throw new Error(`Too many redirects (${maxRedirects}) for ${urlString}`)
  }

  const currentUrl = new URL(urlString)
  const isHttps = currentUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const agent = customAgent || (isHttps ? httpsAgent : httpAgent)

  const reqHeaders = {
    'Accept-Encoding': 'br, gzip, deflate',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ...customHeaders
  }

  let payloadBuffer = null
  if (body != null && !['GET', 'HEAD'].includes(method)) {
    const isFormUrlEncoded =
      reqHeaders['Content-Type'] === 'application/x-www-form-urlencoded'
    let rawPayload

    if (isFormUrlEncoded && typeof body === 'string') {
      rawPayload = body
    } else {
      reqHeaders['Content-Type'] =
        reqHeaders['Content-Type'] || 'application/json'
      rawPayload = typeof body === 'string' ? body : JSON.stringify(body)
    }

    if (disableBodyCompression) {
      payloadBuffer = Buffer.from(rawPayload)
    } else {
      reqHeaders['Content-Encoding'] = 'gzip'
      payloadBuffer = zlib.gzipSync(rawPayload)
    }
  }

  const reqOptions = {
    method,
    agent,
    timeout,
    hostname: currentUrl.hostname,
    port: currentUrl.port || (isHttps ? 443 : 80),
    path: currentUrl.pathname + currentUrl.search,
    headers: reqHeaders,
    localAddress
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(reqOptions, (res) => {
      const { statusCode, headers: respHeaders } = res

      if (REDIRECT_STATUS_CODES.includes(statusCode) && respHeaders.location) {
        res.resume()
        const nextUrl = new URL(respHeaders.location, currentUrl).href
        const isGetRedirect = [301, 302, 303].includes(statusCode)
        const nextOptions = {
          ...options,
          _redirectsFollowed: _redirectsFollowed + 1,
          method: isGetRedirect ? 'GET' : method,
          body: isGetRedirect ? undefined : body
        }
        resolve(http1makeRequest(nextUrl, nextOptions))
        return
      }

      let finalStream = res
      const encoding = (respHeaders['content-encoding'] || '').toLowerCase()
      if (encoding === 'br') {
        finalStream = res.pipe(zlib.createBrotliDecompress())
      } else if (encoding === 'gzip') {
        finalStream = res.pipe(zlib.createGunzip())
      } else if (encoding === 'deflate') {
        finalStream = res.pipe(zlib.createInflate())
      }

      res.on('error', (err) =>
        reject(new Error(`Response error for ${urlString}: ${err.message}`))
      )
      if (finalStream !== res) {
        finalStream.on('error', (err) =>
          reject(
            new Error(`Decompression error for ${urlString}: ${err.message}`)
          )
        )
      }

      if (streamOnly) {
        resolve({ statusCode, headers: respHeaders, stream: finalStream })
        return
      }

      const chunks = []
      finalStream.on('data', (chunk) => chunks.push(chunk))
      finalStream.on('end', () => {
        try {
          const responseBuffer = Buffer.concat(chunks)

          if (options.responseType === 'buffer') {
            resolve({ statusCode, headers: respHeaders, body: responseBuffer })
            return
          }

          const text = responseBuffer.toString('utf8')
          const isJson = (respHeaders['content-type'] || '')
            .toLowerCase()
            .startsWith('application/json')
          const responseBody = isJson && text ? JSON.parse(text) : text
          resolve({ statusCode, headers: respHeaders, body: responseBody })
        } catch (err) {
          reject(
            new Error(
              `Error processing response body for ${urlString}: ${err.message}`
            )
          )
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.on('timeout', () =>
      req.destroy(
        new Error(`Request timed out after ${timeout}ms for ${urlString}`)
      )
    )

    if (payloadBuffer) {
      req.end(payloadBuffer)
    } else {
      req.end()
    }
  })
}

async function http1makeRequest(urlString, options = {}) {
  const { maxRetries = 3 } = options
  let attempt = 0

  while (true) {
    try {
      const isHttps = new URL(urlString).protocol === 'https:'
      const useKeepAlive = !options.streamOnly
      const agent = useKeepAlive
        ? isHttps
          ? httpsAgent
          : httpAgent
        : new (isHttps ? https : http).Agent({ keepAlive: false })

      const newOptions = { ...options, agent }

      return await _internalHttp1Request(urlString, newOptions)
    } catch (err) {
      const isRetryable = [
        'ECONNRESET',
        'ETIMEDOUT',
        'EPIPE',
        'ENETUNREACH',
        'EHOSTUNREACH'
      ].includes(err.code)

      if (isRetryable && attempt < maxRetries) {
        attempt++
        const delay = 100 * Math.pow(2, attempt)
        logger(
          'warn',
          'Network',
          `Request for ${urlString} failed with ${err.code}. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      } else {
        throw err
      }
    }
  }
}

async function makeRequest(urlString, options, nodelink) {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeout = Math.max(1, options.timeout ?? 30000),
    streamOnly = false,
    disableBodyCompression = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    _redirectsFollowed = 0
  } = options

  const logId = crypto.randomBytes(4).toString('hex')
  if (loggingConfig.debug?.network) {
    logger('debug', 'Network', `[${logId}] Request: ${method} ${urlString}`)
    logger(
      'debug',
      'Network',
      `[${logId}] Headers: ${JSON.stringify(customHeaders, (key, value) => (key.toLowerCase().includes('authorization') || key.toLowerCase().includes('cookie') ? '[REDACTED]' : value))}`
    )
    if (body) {
      const bodySnippet =
        typeof body === 'string'
          ? body.substring(0, 200)
          : JSON.stringify(body).substring(0, 200)
      logger(
        'debug',
        'Network',
        `[${logId}] Body: ${bodySnippet}${bodySnippet.length === 200 ? '...' : ''}`
      )
    }
  }

  if (_redirectsFollowed >= maxRedirects) {
    return Promise.reject(
      new Error(`Too many redirects (${maxRedirects}) for ${urlString}`)
    )
  }
  const localAddress = nodelink?.routePlanner?.getIP()

  try {
    const url = new URL(urlString)
    if (http2FailedHosts.has(url.host)) {
      return http1makeRequest(urlString, { ...options, localAddress }, nodelink)
    }
  } catch (e) {
    return http1makeRequest(urlString, { ...options, localAddress }, nodelink)
  }

  return new Promise((resolve, reject) => {
    let session
    let sessionClosed = false
    let currentUrl

    const fallbackToHttp1 = () => {
      if (!sessionClosed && session) {
        sessionClosed = true
        session.close()
      }
      try {
        const url = new URL(urlString)
        http2FailedHosts.add(url.host)
      } catch (e) {}
      resolve(
        http1makeRequest(urlString, { ...options, localAddress }, nodelink)
      )
    }

    try {
      currentUrl = new URL(urlString)
      session = http2.connect(currentUrl.origin, { localAddress })

      const closeSessionGracefully = () => {
        if (
          session &&
          !session.closed &&
          !session.destroyed &&
          !sessionClosed
        ) {
          sessionClosed = true
          session.close()
        }
      }

      session.on('error', fallbackToHttp1)
      session.on('goaway', closeSessionGracefully)

      const h2Headers = {
        ':method': method,
        ':path': currentUrl.pathname + currentUrl.search,
        ':scheme': currentUrl.protocol.slice(0, -1),
        ':authority': currentUrl.host,
        'accept-encoding': 'br, gzip, deflate',
        'user-agent': 'Mozilla/5.0 (Node.js Http2Client)',
        dnt: '1',
        ...customHeaders
      }

      if (body && !['GET', 'HEAD'].includes(method)) {
        h2Headers['Content-Type'] =
          typeof body === 'object'
            ? 'application/json'
            : h2Headers['Content-Type']
        if (!disableBodyCompression) h2Headers['content-encoding'] = 'gzip'
      }

      const req = session.request(h2Headers)
      let reqClosed = false

      if (timeout) {
        req.setTimeout(timeout, () => {
          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_CANCEL)
          }
          closeSessionGracefully()
          fallbackToHttp1()
          reject(new Error(`HTTP/2 request timeout for ${urlString}`))
        })
      }

      req.on('error', (err) => {
        if (!reqClosed) reqClosed = true
        closeSessionGracefully()
        fallbackToHttp1()
        reject(
          new Error(`HTTP/2 request error for ${urlString}: ${err.message}`)
        )
      })

      req.on('response', async (headers) => {
        const statusCode = headers[':status']

        if (statusCode === 429) {
          nodelink?.routePlanner?.banIP(localAddress)
        }

        if (REDIRECT_STATUS_CODES.includes(statusCode) && headers.location) {
          const newLocation = new URL(headers.location, urlString).href
          let nextMethod = method
          let nextBody = body
          if (
            (statusCode === 301 || statusCode === 302) &&
            ['POST', 'PUT', 'DELETE'].includes(method)
          ) {
            nextMethod = 'GET'
            nextBody = undefined
          } else if (statusCode === 303) {
            nextMethod = 'GET'
            nextBody = undefined
          }

          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_NO_ERROR)
          }
          closeSessionGracefully()
          return resolve(
            makeRequest(
              newLocation,
              {
                ...options,
                method: nextMethod,
                body: nextBody,
                _redirectsFollowed: _redirectsFollowed + 1,
                disableBodyCompression: nextBody
                  ? disableBodyCompression
                  : undefined
              },
              nodelink
            )
          )
        }

        let responseStream = req
        const encoding = headers['content-encoding']
        if (encoding === 'br')
          responseStream = req.pipe(zlib.createBrotliDecompress())
        else if (encoding === 'gzip')
          responseStream = req.pipe(zlib.createGunzip())
        else if (encoding === 'deflate')
          responseStream = req.pipe(zlib.createInflate())

        if (method === 'HEAD') {
          closeSessionGracefully()
          return resolve({ statusCode, headers })
        }

        if (streamOnly) {
          responseStream.on('end', closeSessionGracefully)
          responseStream.on('error', closeSessionGracefully)
          responseStream.on('close', closeSessionGracefully)
          return resolve({ statusCode, headers, stream: responseStream })
        }

        try {
          const chunks = []
          for await (const chunk of responseStream) chunks.push(chunk)
          const text = Buffer.concat(chunks).toString()
          const isJson = (headers['content-type'] || '')
            .toLowerCase()
            .startsWith('application/json')
          const responseBody = isJson && text ? JSON.parse(text) : text

          if (loggingConfig.debug?.network) {
            const bodySnippet =
              typeof responseBody === 'string'
                ? responseBody.substring(0, 200)
                : JSON.stringify(responseBody).substring(0, 200)
            logger(
              'debug',
              'Network',
              `[${logId}] Response Status: ${statusCode}`
            )
            logger(
              'debug',
              'Network',
              `[${logId}] Response Body: ${bodySnippet}${bodySnippet.length === 200 ? '...' : ''}`
            )
          }

          resolve({
            statusCode,
            headers,
            body: responseBody
          })
        } catch (err) {
          resolve({ statusCode, headers, error: err.message })
        } finally {
          if (!streamOnly) closeSessionGracefully()
        }
      })

      if (body && !['GET', 'HEAD'].includes(method)) {
        const payload = JSON.stringify(body)
        if (
          disableBodyCompression ||
          h2Headers['content-encoding'] !== 'gzip'
        ) {
          req.end(payload)
        } else {
          zlib.gzip(payload, (err, data) => {
            if (err) {
              req.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
              closeSessionGracefully()
              return reject(
                new Error(`Gzip error for ${urlString}: ${err.message}`)
              )
            }
            req.end(data)
          })
        }
      } else {
        req.end()
      }
    } catch (err) {
      if (session && !session.closed && !session.destroyed && !sessionClosed) {
        session.close()
      }
      fallbackToHttp1()
    }
  })
}

function loadHLS(url, stream, onceEnded = false, shouldEnd = true) {
  //biome-ignore lint: no-promise-executor-return
  return new Promise(async (resolve) => {
    try {
      const res = await http1makeRequest(url, { method: 'GET' })
      const lines = res.body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

      if (!lines.some((l) => l.startsWith('#EXTINF'))) {
        const seg = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true
        })
        seg.stream.pipe(stream, { end: shouldEnd })
        return resolve(!shouldEnd)
      }

      const base = new URL(url)
      const segs = []
      let sawEnd = false

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF')) {
          const uri = lines[i + 1]
          if (uri && !uri.startsWith('#')) {
            segs.push(new URL(uri, base).toString())
          }
        }
        if (lines[i].startsWith('#EXT-X-ENDLIST')) sawEnd = true
      }

      const downloadPromises = []

      const writeChunksToStream = async (chunks) => {
        for (const chunk of chunks) {
          if (!stream.write(chunk)) {
            await new Promise((ok) => stream.once('drain', ok))
          }
        }
      }

      for (const segUrl of segs) {
        if (stream.destroyed) break

        const downloadPromise = http1makeRequest(segUrl, {
          method: 'GET',
          streamOnly: true
        })
          .then((s) => {
            return new Promise((res, rej) => {
              const chunks = []
              s.stream.on('data', (chunk) => chunks.push(chunk))
              s.stream.on('end', () => res(chunks))
              s.stream.on('error', rej)
            })
          })
          .catch((err) => {
            if (!stream.destroyed) {
              console.error(
                '[HLS] Error downloading segment',
                err.code || err.message
              )
              stream.destroy(err)
            }
            return Promise.reject(err)
          })

        downloadPromises.push(downloadPromise)

        if (downloadPromises.length >= HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT) {
          if (stream.destroyed) break
          try {
            const chunks = await downloadPromises.shift()
            await writeChunksToStream(chunks)
          } catch (e) {
            break
          }
        }
      }

      while (downloadPromises.length > 0) {
        if (stream.destroyed) break
        try {
          const chunks = await downloadPromises.shift()
          await writeChunksToStream(chunks)
        } catch (e) {
          break
        }
      }

      if (stream.destroyed) {
        return resolve(false)
      }

      if (!sawEnd) {
        resolve(true)
      } else {
        shouldEnd && stream.emit('finishBuffering')
        resolve(false)
      }
    } catch (e) {
      console.error('[HLS] ERR →', e.code || e.message)
      if (!stream.destroyed) {
        shouldEnd && stream.emit('finishBuffering')
      }
      resolve(false)
    }
  })
}

async function loadHLSPlaylist(url, stream) {
  try {
    const res = await http1makeRequest(url, { method: 'GET' })
    const lines = res.body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    if (lines.some((l) => l.startsWith('#EXTINF'))) {
      return loadHLS(url, stream, false, true)
    }

    const audioTags = lines.filter(
      (l) =>
        l.startsWith('#EXT-X-MEDIA') &&
        l.includes('TYPE=AUDIO') &&
        l.includes('URI="')
    )
    if (audioTags.length) {
      const defaultTag = audioTags.find((l) => /DEFAULT=YES/.test(l))
      const pickTag = defaultTag || audioTags[audioTags.length - 1]
      const uri = pickTag.match(/URI="([^"]+)"/)[1]
      const audioUrl = new URL(uri, url).toString()
      return loadHLS(audioUrl, stream, false, true)
    }

    return loadHLS(url, stream, false, true)
  } catch (e) {
    console.error('[HLS-AUDIO] ERR →', e.code || e.message)
    stream.emit('finishBuffering')
    return stream
  }
}

async function checkForUpdates() {
  const isBun = typeof Bun !== 'undefined' && !!process.versions.bun
  // bun is too weird
  if (isBun) {
    logger('info', 'Git', 'Skipping update check (compiled build).')
    return
  }

  logger('info', 'Git', 'Checking for updates...')
  try {
    execSync('git fetch', { stdio: 'ignore' })

    const local = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    const remote = execSync('git rev-parse @{u}', { encoding: 'utf8' }).trim()

    if (local !== remote) {
      const behind = execSync('git rev-list --right-only --count HEAD...@{u}', {
        encoding: 'utf8'
      }).trim()
      const remoteCommit = execSync(
        'git log -1 --pretty=format:"%h - %s (%cr)" @{u}',
        { encoding: 'utf8' }
      ).trim()

      logger(
        'warn',
        'Git',
        `Your version is ${behind} commits behind the remote.`
      )
      logger('warn', 'Git', `Latest commit: ${remoteCommit}`)
      logger('warn', 'Git', 'Please run "git pull" to update.')
    } else {
      logger('info', 'Git', 'You are running the latest version.')
    }
  } catch (error) {
    logger('warn', 'Git', `Failed to check for updates: ${error.message}`)
  }
}

function sendErrorResponse(
  req,
  res,
  status,
  error,
  message,
  path,
  trace = false
) {
  const errorPayload = {
    timestamp: Date.now(),
    status,
    error,
    trace: trace ? new Error().stack : undefined,
    message,
    path
  }
  sendResponse(req, res, errorPayload, status, trace)
}

export function cleanupHttpAgents() {
  try {
    httpAgent.destroy()
    httpsAgent.destroy()
    http2FailedHosts.clear()
    logger('info', 'Utils', 'HTTP agents cleaned up successfully')
  } catch (error) {
    logger('error', 'Utils', `Error cleaning up HTTP agents: ${error.message}`)
  }
}

function applyEnvOverrides(config, prefix = 'NODELINK') {
  for (const key in config) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      const envVarName = `${prefix}_${key.toUpperCase()}`;
      const envValue = process.env[envVarName];

      if (envValue !== undefined) {
        if (typeof config[key] === 'boolean') {
          config[key] = envValue.toLowerCase() === 'true';
        } else if (typeof config[key] === 'number') {
          const numValue = Number(envValue);
          if (!isNaN(numValue)) {
            config[key] = numValue;
          } else {
            logger('warn', 'Config', `Environment variable ${envVarName} has non-numeric value "${envValue}"; expected a number, keeping default.`)
          }
        } else if (typeof config[key] === 'string') {
          config[key] = envValue;
        } else if (Array.isArray(config[key])) {
          try {
            const parsedArray = JSON.parse(envValue);
            if (Array.isArray(parsedArray)) {
              config[key] = parsedArray;
            } else {
              logger('warn', 'Config', `Environment variable ${envVarName} has non-array JSON value "${envValue}"; expected a JSON array, keeping default.`)
            }
          } catch (e) {
            logger('warn', 'Config', `Environment variable ${envVarName} has non-JSON or invalid JSON value "${envValue}"; expected a JSON array, keeping default.`)
          }
        }
      } else if (typeof config[key] === 'object' && config[key] !== null && !Array.isArray(config[key])) {
        applyEnvOverrides(config[key], envVarName);
      }
    }
  }
}

function cleanupLogger() {
  if (logRotationInterval) {
    clearInterval(logRotationInterval)
    logRotationInterval = null
  }

  if (logCleanupInterval) {
    clearInterval(logCleanupInterval)
    logCleanupInterval = null
  }

  if (logStream) {
    logStream.end()
    logStream = null
  }
}

export {
  initLogger,
  cleanupLogger,
  validateProperty,
  logger,
  getVersion,
  parseSemver,
  getGitInfo,
  getStats,
  verifyMethod,
  decodeTrack,
  encodeTrack,
  generateRandomLetters,
  parseClient,
  verifyDiscordID,
  makeRequest,
  http1makeRequest,
  loadHLSPlaylist,
  sendResponse,
  loadHLS,
  checkForUpdates,
  sendErrorResponse,
  applyEnvOverrides
}
