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

const hasZstd = !!zlib.createZstdDecompress

import packageJson from '../package.json' with { type: 'json' }
import {
  DEFAULT_MAX_REDIRECTS,
  DISCORD_ID_REGEX,
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
    const categoryKey =
      typeof category === 'string' ? category.toLowerCase() : category
    const categoryEnabled =
      debugConfig[category] ??
      (categoryKey ? debugConfig[categoryKey] : undefined)

    if (debugConfig.all) {
      if (categoryEnabled === false) return
    } else if (!categoryEnabled) {
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

function validateProperty(value, path, expected, validator) {
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

function modifyPayload(nodelink, data) {
  if (!data || typeof data !== 'object') return data
  const modifiers = nodelink.extensions?.trackModifiers
  if (!modifiers || modifiers.length === 0) return data

  if (Array.isArray(data)) {
    return data.map((item) => modifyPayload(nodelink, item))
  }

  const modifiedData = { ...data }

  if (modifiedData.info && modifiedData.encoded !== undefined) {
    for (const modifier of modifiers) {
      try {
        modifier(modifiedData)
      } catch (e) {
        logger('error', 'PluginManager', `Track modifier error: ${e.message}`)
      }
    }
  }

  for (const key in modifiedData) {
    if (typeof modifiedData[key] === 'object' && key !== 'info') {
      modifiedData[key] = modifyPayload(nodelink, modifiedData[key])
    }
  }

  return modifiedData
}

function sendResponse(req, res, data, status, trace = false) {
  const headers = {}

  if (!data) {
    res.writeHead(status, headers)
    res.end()
    return
  }

  const nodelink = global.nodelink
  let finalData = nodelink ? modifyPayload(nodelink, data) : data

  if (finalData.trace && !trace) {
    const { trace: _, ...rest } = finalData
    finalData = rest
  }

  headers['Content-Type'] = 'application/json'
  const jsonData = JSON.stringify(finalData)
  const buffer = Buffer.from(jsonData)
  const encoding = req.headers['accept-encoding'] || ''


/*
  // https://bun.com/blog/bun-v1.3.3
  if (process.isBun) {
    headers['Content-Length'] = buffer.byteLength
    res.writeHead(status, headers)
    res.end(buffer)
    return
  } */
  const compressions = [
    { type: 'br', method: zlib.brotliCompress },
    { type: 'gzip', method: zlib.gzip },
    { type: 'deflate', method: zlib.deflate }
  ]
  if (hasZstd) {
    compressions.unshift({ type: 'zstd', method: zlib.zstdCompress })
  }


  for (const { type, method } of compressions) {
    if (encoding.includes(type)) {
      headers['Content-Encoding'] = type
      method(buffer, (err, result) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Compression failed' }))
          return
        }
        headers['Content-Length'] = result.byteLength
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
  if (typeof __BUILD_GIT_INFO__ !== 'undefined') {
    return __BUILD_GIT_INFO__
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
  if (!encoded) throw new Error('Decode Error: Input string is null or empty')

  const buffer = Buffer.from(encoded, 'base64')
  let position = 0
  let step = 'init'

  const ensure = (n) => {
    if (position + n > buffer.length)
      throw new Error(`Unexpected end of buffer (need ${n} bytes)`)
  }

  const readModifiedUTF8From = (buf, pRef) => {
    if (pRef.value + 2 > buf.length)
      throw new Error('Unexpected end of buffer (need 2 bytes)')
    const utflen = buf.readUInt16BE(pRef.value)
    pRef.value += 2
    if (pRef.value + utflen > buf.length)
      throw new Error(`Unexpected end of buffer (need ${utflen} bytes)`)

    const end = pRef.value + utflen
    const chars = []
    let i = pRef.value

    while (i < end) {
      const c = buf[i] & 0xff

      if (c < 0x80) {
        i += 1
        chars.push(String.fromCharCode(c))
        continue
      }

      if ((c & 0xe0) === 0xc0) {
        if (i + 1 >= end) throw new Error('Malformed utf')
        const c2 = buf[i + 1] & 0xff
        if ((c2 & 0xc0) !== 0x80) throw new Error('Malformed utf')
        const ch = ((c & 0x1f) << 6) | (c2 & 0x3f)
        i += 2
        chars.push(String.fromCharCode(ch))
        continue
      }

      if ((c & 0xf0) === 0xe0) {
        if (i + 2 >= end) throw new Error('Malformed utf')
        const c2 = buf[i + 1] & 0xff
        const c3 = buf[i + 2] & 0xff
        if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80)
          throw new Error('Malformed utf')
        const ch = ((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f)
        i += 3
        chars.push(String.fromCharCode(ch))
        continue
      }

      throw new Error('Malformed utf')
    }

    pRef.value = end
    return chars.join('')
  }

  const readNullableTextFrom = (buf, pRef) => {
    if (pRef.value + 1 > buf.length)
      throw new Error('Unexpected end of buffer (need 1 byte)')
    const present = buf[pRef.value++] !== 0
    return present ? readModifiedUTF8From(buf, pRef) : null
  }

  const decodeDetailsAsList = (detailsBuf) => {
    let p = 0
    const ensure2 = (n) => {
      if (p + n > detailsBuf.length)
        throw new Error('Unexpected end of details')
    }

    const readUTF2 = () => {
      ensure2(2)
      const utflen = detailsBuf.readUInt16BE(p)
      p += 2
      ensure2(utflen)

      const end = p + utflen
      const chars = []
      let i = p

      while (i < end) {
        const c = detailsBuf[i] & 0xff

        if (c < 0x80) {
          i += 1
          chars.push(String.fromCharCode(c))
          continue
        }

        if ((c & 0xe0) === 0xc0) {
          if (i + 1 >= end) throw new Error('Malformed utf')
          const c2 = detailsBuf[i + 1] & 0xff
          if ((c2 & 0xc0) !== 0x80) throw new Error('Malformed utf')
          const ch = ((c & 0x1f) << 6) | (c2 & 0x3f)
          i += 2
          chars.push(String.fromCharCode(ch))
          continue
        }

        if ((c & 0xf0) === 0xe0) {
          if (i + 2 >= end) throw new Error('Malformed utf')
          const c2 = detailsBuf[i + 1] & 0xff
          const c3 = detailsBuf[i + 2] & 0xff
          if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80)
            throw new Error('Malformed utf')
          const ch = ((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f)
          i += 3
          chars.push(String.fromCharCode(ch))
          continue
        }

        throw new Error('Malformed utf')
      }

      p = end
      return chars.join('')
    }

    const readNullable2 = () => {
      ensure2(1)
      const present = detailsBuf[p++] !== 0
      return present ? readUTF2() : null
    }

    const out = []
    while (p < detailsBuf.length) out.push(readNullable2())
    while (out.length && out[out.length - 1] === null) out.pop()
    return out
  }

  const tryParseSeekableTrailer = (buf) => {
    let p = 0
    try {
      if (buf.length < 1) return { ok: false }
      const present = buf[p++] !== 0
      if (!present) return { ok: false }
      const pRef = { value: p }
      const s = readModifiedUTF8From(buf, pRef)
      if (pRef.value !== buf.length) return { ok: false }
      if (s === 'NLK:seekableY') return { ok: true, seekable: true }
      if (s === 'NLK:seekableN') return { ok: true, seekable: false }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }

  try {
    step = 'messageHeader'
    ensure(4)
    const header = buffer.readInt32BE(position)
    position += 4

    const flags = (header >>> 30) & 0x3
    const messageSize = header & 0x3fffffff
    if (messageSize === 0) throw new Error('message size: 0')

    step = 'messageBody'
    ensure(messageSize)
    let messageBuf = buffer.subarray(position, position + messageSize)
    position += messageSize

    let seekable
    {
      const tailTryMax = Math.min(messageBuf.length, 512)
      for (let cut = 1; cut <= tailTryMax; cut++) {
        const tail = messageBuf.subarray(messageBuf.length - cut)
        const parsed = tryParseSeekableTrailer(tail)
        if (parsed.ok) {
          seekable = parsed.seekable
          messageBuf = messageBuf.subarray(0, messageBuf.length - cut)
          break
        }
      }
    }

    step = 'payload'
    const pRef = { value: 0 }

    if (pRef.value + 1 > messageBuf.length)
      throw new Error('Unexpected end of message (need 1 byte)')
    const version = messageBuf[pRef.value++] & 0xff

    const title = readModifiedUTF8From(messageBuf, pRef)
    const author = readModifiedUTF8From(messageBuf, pRef)

    if (pRef.value + 8 > messageBuf.length)
      throw new Error('Unexpected end of message (need 8 bytes)')
    const length = Number(messageBuf.readBigInt64BE(pRef.value))
    pRef.value += 8

    const identifier = readModifiedUTF8From(messageBuf, pRef)

    if (pRef.value + 1 > messageBuf.length)
      throw new Error('Unexpected end of message (need 1 byte)')
    const isStream = messageBuf[pRef.value++] !== 0

    const uri = version >= 2 ? readNullableTextFrom(messageBuf, pRef) : null
    const artworkUrl =
      version >= 3 ? readNullableTextFrom(messageBuf, pRef) : null
    const isrc = version >= 3 ? readNullableTextFrom(messageBuf, pRef) : null

    const sourceName = readModifiedUTF8From(messageBuf, pRef)

    const positionOffset = messageBuf.length - 8
    const detailsBuf = messageBuf.subarray(pRef.value, positionOffset)
    const trackPosition = Number(messageBuf.readBigInt64BE(positionOffset))

    let details = []
    if (detailsBuf.length > 0) {
      try {
        details = decodeDetailsAsList(detailsBuf)
      } catch {
        details = []
      }
    }

    return {
      encoded,
      info: {
        title,
        author,
        length,
        identifier,
        isSeekable: typeof seekable === 'boolean' ? seekable : !isStream,
        isStream,
        uri,
        artworkUrl,
        isrc,
        sourceName,
        position: trackPosition
      },
      details,
      pluginInfo: {},
      userData: {},
      messageFlags: flags
    }
  } catch (err) {
    throw new Error(
      `Decode Error at [${step}]: ${err.message} (Buffer pos: ${position}/${buffer.length})`
    )
  }
}

function encodeTrack(track) {
  if (!track || typeof track !== 'object') {
    throw new Error('Encode Error: Input track must be a valid object')
  }

  const encodeModifiedUTF8 = (value) => {
    const str = String(value)
    const bytes = []

    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)

      if (ch >= 0x0001 && ch <= 0x007f) {
        bytes.push(ch)
      } else if (ch === 0x0000 || (ch >= 0x0080 && ch <= 0x07ff)) {
        bytes.push(0xc0 | ((ch >> 6) & 0x1f))
        bytes.push(0x80 | (ch & 0x3f))
      } else {
        bytes.push(0xe0 | ((ch >> 12) & 0x0f))
        bytes.push(0x80 | ((ch >> 6) & 0x3f))
        bytes.push(0x80 | (ch & 0x3f))
      }
    }

    if (bytes.length > 65535)
      throw new Error('Encode Error: UTF string too long')

    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(bytes.length)
    return Buffer.concat([lenBuf, Buffer.from(bytes)])
  }

  const chunks = []
  const push = (b) => chunks.push(b)

  const writeByte = (v) => push(Buffer.from([v & 0xff]))
  const writeLong = (v) => {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v))
    push(b)
  }
  const writeUTF = (v) => push(encodeModifiedUTF8(v))
  const writeNullableText = (v) => {
    if (v === undefined || v === null) {
      writeByte(0)
    } else {
      writeByte(1)
      writeUTF(String(v))
    }
  }

  const version = track.artworkUrl || track.isrc ? 3 : track.uri ? 2 : 1
  const flags = 1

  const seekable =
    typeof track.isSeekable === 'boolean'
      ? track.isSeekable
      : typeof track?.info?.isSeekable === 'boolean'
        ? track.info.isSeekable
        : undefined

  writeByte(version)
  writeUTF(track.title)
  writeUTF(track.author)
  writeLong(track.length)
  writeUTF(track.identifier)
  writeByte(track.isStream ? 1 : 0)

  if (version >= 2) writeNullableText(track.uri ?? null)
  if (version >= 3) {
    writeNullableText(track.artworkUrl ?? null)
    writeNullableText(track.isrc ?? null)
  }

  writeUTF(track.sourceName)

  if (Array.isArray(track.details)) {
    for (const detail of track.details) writeNullableText(detail)
  }

  writeLong(track.position ?? 0)

  if (typeof seekable === 'boolean') {
    writeNullableText(seekable ? 'NLK:seekableY' : 'NLK:seekableN')
  }

  const messageBuf = Buffer.concat(chunks)
  const header = (messageBuf.length & 0x3fffffff) | ((flags & 0x3) << 30)

  const headerBuf = Buffer.alloc(4)
  headerBuf.writeInt32BE(header)

  return Buffer.concat([headerBuf, messageBuf]).toString('base64')
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

const httpAgent = new http.Agent({
  keepAlive: true,
  maxFreeSockets: 32,
  maxSockets: Infinity,
  timeout: 60000
})
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: 32,
  maxSockets: Infinity,
  timeout: 60000
})
const http2FailedHosts = new Set()

setInterval(
  () => {
    if (http2FailedHosts.size > 0) {
      http2FailedHosts.clear()
    }
  },
  6 * 60 * 60 * 1000
).unref()

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

  const actualLocalAddress =
    localAddress || global.nodelink?.routePlanner?.getIP()

  if (_redirectsFollowed >= maxRedirects) {
    throw new Error(`Too many redirects (${maxRedirects}) for ${urlString}`)
  }

  const currentUrl = new URL(urlString)
  const isHttps = currentUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const agent = customAgent || (isHttps ? httpsAgent : httpAgent)

  const acceptEncoding = ['br', 'gzip', 'deflate']
  if (hasZstd) acceptEncoding.unshift('zstd')

  const reqHeaders = {
    'Accept-Encoding': acceptEncoding.join(', '),
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ...customHeaders
  }

  let payloadBuffer = null
  if (body != null && !['GET', 'HEAD'].includes(method)) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      payloadBuffer = Buffer.from(body)
    } else {
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
  }

  const reqOptions = {
    method,
    agent,
    timeout,
    hostname: currentUrl.hostname,
    port: currentUrl.port || (isHttps ? 443 : 80),
    path: currentUrl.pathname + currentUrl.search,
    headers: reqHeaders,
    localAddress: actualLocalAddress
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let hardTimeout = null
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      if (hardTimeout) clearTimeout(hardTimeout)
      reject(error)
    }
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      if (hardTimeout) clearTimeout(hardTimeout)
      resolve(value)
    }

    const req = lib.request(reqOptions, (res) => {
      const { statusCode, headers: respHeaders } = res

      if (REDIRECT_STATUS_CODES.includes(statusCode) && respHeaders.location) {
        res.resume()
        const nextUrl = new URL(respHeaders.location, currentUrl).href
        const isGetRedirect = [301, 302, 303].includes(statusCode)
        let nextMethod = method
        let nextBody = body
        if (method === 'HEAD') {
          nextMethod = 'HEAD'
          nextBody = undefined
        } else if (isGetRedirect) {
          nextMethod = 'GET'
          nextBody = undefined
        }
        const nextOptions = {
          ...options,
          _redirectsFollowed: _redirectsFollowed + 1,
          method: nextMethod,
          body: nextBody
        }
        resolveOnce(http1makeRequest(nextUrl, nextOptions))
        return
      }

      let finalStream = res
      const encoding = (respHeaders['content-encoding'] || '').toLowerCase()
      if (encoding === 'zstd' && hasZstd) {
        finalStream = res.pipe(zlib.createZstdDecompress())
      } else if (encoding === 'br') {
        finalStream = res.pipe(zlib.createBrotliDecompress())
      } else if (encoding === 'gzip') {
        finalStream = res.pipe(zlib.createGunzip())
      } else if (encoding === 'deflate') {
        finalStream = res.pipe(zlib.createInflate())
      }

      res.on('error', (err) =>
        rejectOnce(new Error(`Response error for ${urlString}: ${err.message}`))
      )
      if (finalStream !== res) {
        finalStream.on('error', (err) =>
          rejectOnce(
            new Error(`Decompression error for ${urlString}: ${err.message}`)
          )
        )
      }

      if (streamOnly) {
        resolveOnce({ statusCode, headers: respHeaders, stream: finalStream })
        return
      }

      const chunks = []
      finalStream.on('data', (chunk) => chunks.push(chunk))
      finalStream.on('end', () => {
        try {
          const responseBuffer = Buffer.concat(chunks)

          if (options.responseType === 'buffer') {
            resolveOnce({ statusCode, headers: respHeaders, body: responseBuffer })
            return
          }

          const text = responseBuffer.toString('utf8')
          const isJson = (respHeaders['content-type'] || '')
            .toLowerCase()
            .startsWith('application/json')
          const responseBody = isJson && text ? JSON.parse(text) : text
          resolveOnce({ statusCode, headers: respHeaders, body: responseBody })
        } catch (err) {
          rejectOnce(
            new Error(
              `Error processing response body for ${urlString}: ${err.message}`
            )
          )
        }
      })
    })

    req.on('error', (err) => rejectOnce(err))
    req.on('timeout', () => {
      req.destroy(
        new Error(`Request timed out after ${timeout}ms for ${urlString}`)
      )
    })
    if (timeout > 0) {
      hardTimeout = setTimeout(() => {
        req.destroy(
          new Error(`Request hard timeout after ${timeout}ms for ${urlString}`)
        )
      }, timeout)
      hardTimeout.unref?.()
    }

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
        const delay = 100 * 2 ** attempt
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

  const finalNodeLink = nodelink || global.nodelink
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
  const localAddress = finalNodeLink?.routePlanner?.getIP()

  try {
    const url = new URL(urlString)
    if (http2FailedHosts.has(url.host)) {
      return http1makeRequest(
        urlString,
        { ...options, localAddress },
        finalNodeLink
      )
    }
  } catch (_e) {
    return http1makeRequest(
      urlString,
      { ...options, localAddress },
      finalNodeLink
    )
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
      } catch (_e) {}
      resolve(
        http1makeRequest(urlString, { ...options, localAddress }, finalNodeLink)
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
        'accept-encoding': hasZstd
          ? 'zstd, br, gzip, deflate'
          : 'br, gzip, deflate',
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
          finalNodeLink?.routePlanner?.banIP(localAddress)
        }

        if (REDIRECT_STATUS_CODES.includes(statusCode) && headers.location) {
          const newLocation = new URL(headers.location, urlString).href
          let nextMethod = method
          let nextBody = body
          if (method === 'HEAD') {
            nextMethod = 'HEAD'
            nextBody = undefined
          } else if (
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
              finalNodeLink
            )
          )
        }

        let responseStream = req
        const encoding = headers['content-encoding']
        if (encoding === 'zstd' && hasZstd)
          responseStream = req.pipe(zlib.createZstdDecompress())
        else if (encoding === 'br')
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
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
          req.end(Buffer.from(body))
        } else {
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
        }
      } else {
        req.end()
      }
    } catch (_err) {
      if (session && !session.closed && !session.destroyed && !sessionClosed) {
        session.close()
      }
      fallbackToHttp1()
    }
  })
}

function loadHLS(url, stream, _onceEnded = false, shouldEnd = true) {
  // biome-ignore lint: no-promise-executor-return
  return new Promise(async (resolve) => {
    try {
      const writeAndWait = async (chunk) => {
        if (stream.destroyed) return false
        const canWrite = stream.write(chunk)
        if (!canWrite && !stream.destroyed) {
          await new Promise((res) => {
            const onDrain = () => {
              stream.removeListener('close', onClose)
              res()
            }
            const onClose = () => {
              stream.removeListener('drain', onDrain)
              res()
            }
            stream.once('drain', onDrain)
            stream.once('close', onClose)
          })
        }
        return !stream.destroyed
      }

      const res = await http1makeRequest(url, { method: 'GET' })

      if (res.error || res.statusCode !== 200) {
        logger('warn', 'Network', `Failed to fetch HLS playlist: ${res.statusCode}`)
        return resolve(false)
      }

      const lines = res.body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)

      if (!lines.some((l) => l.startsWith('#EXTINF'))) {
        const seg = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true
        })

        if (seg.error || !seg.stream) {
          logger('warn', 'Network', `Failed to fetch direct segment: ${seg.statusCode}`)
          return resolve(false)
        }

        seg.stream.pipe(stream, { end: shouldEnd })
        seg.stream.on('end', () => {
          if (shouldEnd) stream.emit('finishBuffering')
          resolve(!shouldEnd)
        })
        seg.stream.on('error', (err) => {
          if (!stream.destroyed) stream.destroy(err)
          resolve(false)
        })
        return
      }

      const base = new URL(url)

      const mapTag = lines.find((l) => l.startsWith('#EXT-X-MAP:'))
      if (mapTag) {
        const mapUriMatch = mapTag.match(/URI="([^"]+)"/)
        if (mapUriMatch) {
          const initUrl = new URL(mapUriMatch[1], base).toString()
          const initRes = await http1makeRequest(initUrl, {
            method: 'GET',
            responseType: 'buffer'
          })

          if (!initRes.error && initRes.body) {
            const ok = await writeAndWait(initRes.body)
            if (!ok) return resolve(false)
          } else {
            logger(
              'warn',
              'HLS',
              `Failed to download initialization segment: ${initUrl}`
            )
          }
        }
      }

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

      for (let i = 0; i < segs.length; i++) {
        if (stream.destroyed) break

        try {
          const s = await http1makeRequest(segs[i], {
            method: 'GET',
            streamOnly: true
          })

          if (s.error || !s.stream || s.statusCode >= 400) {
            logger('warn', 'HLS', `Failed to download segment ${i} (${segs[i]}): ${s.statusCode}`)
            continue
          }

          await new Promise((res, rej) => {
            const onEnd = () => {
              stream.removeListener('error', onError)
              res()
            }
            const onError = (err) => {
              s.stream.destroy()
              rej(err)
            }
            s.stream.pipe(stream, { end: false })
            s.stream.on('end', onEnd)
            s.stream.on('error', (err) => {
              stream.removeListener('error', onError)
              rej(err)
            })
            stream.once('error', onError)
          })
        } catch (err) {
          if (!stream.destroyed) {
            logger('warn', 'HLS', `Error during segment ${i}: ${err.message}`)
          }
          break
        }
      }

      if (stream.destroyed) {
        return resolve(false)
      }

      if (!sawEnd) {
        resolve(true)
      } else {
        if (shouldEnd) {
          stream.emit('finishBuffering')
          stream.end()
        }
        resolve(false)
      }
    } catch (e) {
      logger('warn', 'HLS', `Error during segment download: ${e.code || e.message}`)
      if (!stream.destroyed) {
        if (shouldEnd) {
          stream.emit('finishBuffering')
          stream.end()
        }
      }
      resolve(false)
    }
  })
}

async function loadHLSPlaylist(url, stream) {
  try {
    const res = await http1makeRequest(url, { method: 'GET' })

    if (res.error || res.statusCode !== 200 || !res.body) {
      logger(
        'warn',
        'HLS',
        `Failed to fetch HLS playlist: ${res.statusCode || res.error || 'empty body'}`
      )
      stream.emit('finishBuffering')
      stream.end()
      return stream
    }

    const lines = res.body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    if (!lines.length) {
      logger('warn', 'HLS', 'Empty HLS playlist received')
      stream.emit('finishBuffering')
      stream.end()
      return stream
    }

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
      const uriMatch = pickTag.match(/URI="([^"]+)"/)
      if (uriMatch && uriMatch[1]) {
        const audioUrl = new URL(uriMatch[1], url).toString()
        return loadHLS(audioUrl, stream, false, true)
      }
    }

    return loadHLS(url, stream, false, true)
  } catch (e) {
    logger('warn', 'HLS', `Failed to load HLS playlist: ${e.code || e.message}`)
    if (!stream.destroyed) {
      stream.emit('finishBuffering')
      stream.end()
    }
    return stream
  }
}

async function checkForUpdates() {
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
    if (Object.hasOwn(config, key)) {
      const envVarName = `${prefix}_${key.toUpperCase()}`
      const envValue = process.env[envVarName]

      if (envValue !== undefined) {
        if (typeof config[key] === 'boolean') {
          config[key] = envValue.toLowerCase() === 'true'
        } else if (typeof config[key] === 'number') {
          const numValue = Number(envValue)
          if (!Number.isNaN(numValue)) {
            config[key] = numValue
          } else {
            logger(
              'warn',
              'Config',
              `Environment variable ${envVarName} has non-numeric value "${envValue}"; expected a number, keeping default.`
            )
          }
        } else if (typeof config[key] === 'string') {
          config[key] = envValue
        } else if (Array.isArray(config[key])) {
          let newValue = null
          try {
            const parsedArray = JSON.parse(envValue)
            if (Array.isArray(parsedArray)) newValue = parsedArray
          } catch (_e) {}

          if (!newValue) {
            const splitValue = envValue
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            if (splitValue.length > 0) newValue = splitValue
          }

          if (newValue) {
            config[key] = newValue
          } else {
            logger(
              'warn',
              'Config',
              `Environment variable ${envVarName} has invalid array value "${envValue}"; keeping default.`
            )
          }
        }
      } else if (
        typeof config[key] === 'object' &&
        config[key] !== null &&
        !Array.isArray(config[key])
      ) {
        applyEnvOverrides(config[key], envVarName)
      }
    }
  }
}

function getBestMatch(list, original, options = {}) {
  const { durationTolerance = 0.15, allowExplicit = true } = options

  const normalize = (str) => {
    if (!str) return ''
    return str
      .toLowerCase()
      .replace(/feat\.?/g, '')
      .replace(/ft\.?/g, '')
      .replace(
        /\s*\([^)]*(official|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
        ''
      )
      .replace(
        /\s*\[[^\]]*(official|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
        ''
      )
      .replace(/[^\w\s]/g, '')
      .trim()
  }

  const specKeywords = [
    'remix',
    'orchestral',
    'live',
    'cover',
    'acoustic',
    'instrumental',
    'karaoke',
    'radio',
    'edit',
    'extended',
    'slowed',
    'reverb'
  ]
  const findSpec = (str) =>
    specKeywords.filter((k) => str.toLowerCase().includes(k))

  const originalTitle = original.title.toLowerCase()
  const originalSpec = findSpec(originalTitle)
  const isOriginalExplicit =
    original.uri?.includes('explicit=true') ||
    originalTitle.includes('explicit')

  const targetDuration = original.length
  const allowedDiff = targetDuration * durationTolerance
  const normOriginalAuthor = normalize(original.author)
  const originalWords = new Set(
    normalize(original.title)
      .split(' ')
      .filter((w) => w.length > 1)
  )

  const scored = list.map((item) => {
    const itemTitle = item.info.title.toLowerCase()
    const normItemTitle = normalize(itemTitle)
    const normItemAuthor = normalize(item.info.author)
    const itemSpec = findSpec(itemTitle)
    const isItemClean =
      itemTitle.includes('clean') || itemTitle.includes('radio edit')
    let score = 0

    const itemWords = normItemTitle.split(' ').filter((w) => w.length > 1)
    const itemWordsSet = new Set(itemWords)

    let overlap = 0
    for (const word of originalWords) {
      if (itemWordsSet.has(word)) overlap++
    }
    score += (overlap / Math.max(originalWords.size, 1)) * 300

    for (const spec of specKeywords) {
      const inOriginal = originalSpec.includes(spec)
      const inItem = itemSpec.includes(spec)
      if (inOriginal && inItem) score += 200
      if (inOriginal !== inItem) score -= 300
    }

    if (isOriginalExplicit && !allowExplicit) {
      if (isItemClean) score += 500
    }

    if (
      normItemAuthor.includes(normOriginalAuthor) ||
      normOriginalAuthor.includes(normItemAuthor)
    ) {
      score += 150
    } else {
      const longer =
        normOriginalAuthor.length > normItemAuthor.length
          ? normOriginalAuthor
          : normItemAuthor
      const shorter =
        normOriginalAuthor.length > normItemAuthor.length
          ? normItemAuthor
          : normOriginalAuthor
      if (shorter.length > 2 && longer.includes(shorter)) score += 100
    }

    if (targetDuration > 0) {
      const diff = Math.abs(item.info.length - targetDuration)
      if (diff <= allowedDiff) {
        score += (1 - diff / allowedDiff) * 100
      } else {
        score -= 100
      }
    }

    if (itemTitle.includes('official audio') || itemTitle.includes('topic'))
      score += 50

    return { item, score }
  })

  scored.sort((a, b) => b.score - a.score)

  return scored[0]?.item || list[0] || null
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
  applyEnvOverrides,
  getBestMatch
}
