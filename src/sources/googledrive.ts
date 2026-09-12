import crypto from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import type { GoogleDriveSourceConfig } from '../typings/config/config.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import type { TrackEncodeInput } from '../typings/utils.types.ts'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.ts'

interface GoogleDrivePlaybackResponse {
  mediaStreamingData?: {
    formatStreamingData?: {
      progressiveTranscodes?: Array<{
        itag: number
        url: string
        transcodeMetadata?: { mimeType?: string }
      }>
      adaptiveTranscodes?: Array<{
        itag: number
        url: string
        transcodeMetadata?: { mimeType?: string }
      }>
    }
  }
  mediaMetadata?: {
    title?: string
    duration?: string
  }
}

/**
 * Google Drive source implementation.
 * Follows HttpSource pattern.
 * @public
 */
export default class GoogleDriveSource implements SourceInstance {
  public readonly nodelink: WorkerNodeLink
  public readonly searchTerms = ['gdsearch']
  public readonly patterns = [
    /https?:\/\/(?:docs|drive|drive\.usercontent)\.google\.com\/(?:(?:uc|open|download)\?.*?id=|file\/d\/)([a-zA-Z0-9_-]{28,})/,
    /https?:\/\/video\.google\.com\/get_player\?.*?docid=([a-zA-Z0-9_-]{28,})/,
    /https?:\/\/(?:docs|drive)\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]{28,})/
  ]
  public readonly priority = 90

  private readonly apiKey = 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8'
  private readonly userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
  }

  public async setup(): Promise<boolean> {
    logger('info', 'Sources', 'Google Drive source initialized')
    return true
  }

  private _makeSidAuthHeader(
    cookiesStr: string,
    origin: string
  ): string | null {
    const cookies = cookiesStr.split(';').reduce(
      (acc, cookie) => {
        const parts = cookie.split('=')
        const name = parts[0]?.trim()
        const value = parts.slice(1).join('=').trim()
        if (name && value) acc[name] = value
        return acc
      },
      {} as Record<string, string>
    )

    const sapisid = cookies.SAPISID || cookies['__Secure-3PAPISID']
    if (!sapisid) return null

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const data = `${timestamp} ${sapisid} ${origin}`
    const hashStr = crypto.createHash('sha1').update(data).digest('hex')
    return `SAPISIDHASH ${timestamp}_${hashStr}`
  }

  private async _getCookiesAndAuthHeader(
    url: string,
    origin: string
  ): Promise<{ cookieHeader: string; authHeader: string | null }> {
    const res = await makeRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })

    let cookiesStr = ''
    if (res.headers?.['set-cookie']) {
      const rawCookies = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie']
        : [res.headers['set-cookie']]
      cookiesStr = rawCookies.map((c) => String(c).split(';')[0]).join('; ')
    }

    const driveConfig = this.nodelink.options.sources?.googledrive as
      | GoogleDriveSourceConfig
      | undefined
    const userCookies = driveConfig?.cookies
    if (userCookies) {
      cookiesStr = userCookies
    }

    return {
      cookieHeader: cookiesStr,
      authHeader: this._makeSidAuthHeader(cookiesStr, origin)
    }
  }

  private _getFormat(mime?: string, title?: string): string {
    if (mime) {
      if (/audio\/mpeg/i.test(mime)) return 'mp3'
      const match = mime.match(/[/+]([a-z0-9]+)/i)
      if (match?.[1]) return match[1].toLowerCase()
    }
    if (title) {
      const extMatch = title.match(/\.([a-zA-Z0-9]+)$/i)
      if (extMatch?.[1]) return extMatch[1].toLowerCase()
    }
    return ''
  }

  private _extractDriveConfirmToken(html: string): string | null {
    const tokenMatch =
      html.match(/[?&]confirm=([a-zA-Z0-9_-]+)/) ||
      html.match(/name="confirm"\s+value="([a-zA-Z0-9_-]+)"/i)

    return tokenMatch?.[1] || null
  }

  private _readSynchsafeInt(bytes: Buffer): number {
    return (
      ((bytes[0] || 0) << 21) |
      ((bytes[1] || 0) << 14) |
      ((bytes[2] || 0) << 7) |
      (bytes[3] || 0)
    )
  }

  private _normalizeDriveTitle(title: string): string {
    const normalized = title.replace(' - Google Drive', '').trim()
    if (!normalized || /virus scan warning/i.test(normalized)) return ''
    return normalized
  }

  private _extractFilenameFromContentDisposition(
    contentDisposition: string | null | undefined
  ): string | null {
    if (!contentDisposition) return null

    const utf8Match = contentDisposition.match(
      /filename\*\s*=\s*UTF-8''([^;]+)/i
    )
    if (utf8Match?.[1]) {
      try {
        const decoded = decodeURIComponent(utf8Match[1])
        const cleaned = decoded.replace(/[\\/:*?"<>|]/g, '').trim()
        return cleaned || null
      } catch {}
    }

    const simpleMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i)
    if (simpleMatch?.[1]) {
      const cleaned = simpleMatch[1].replace(/[\\/:*?"<>|]/g, '').trim()
      return cleaned || null
    }

    return null
  }

  private _decodeHtmlEntities(input: string): string {
    return input
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }

  private async _resolveFolderViaEmbedded(
    folderId: string
  ): Promise<{ title: string; tracks: TrackData[] } | null> {
    const embeddedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`
    const webpage = await makeRequest(embeddedUrl, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })

    if (typeof webpage.body !== 'string') return null
    const html = webpage.body

    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const folderTitle = titleMatch?.[1]
      ? this._decodeHtmlEntities(titleMatch[1])
      : 'Google Drive Folder'

    const entryRegex =
      /<div class="flip-entry" id="entry-([A-Za-z0-9_-]{20,})"[\s\S]*?<a href="https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})\/view[^"]*"[\s\S]*?drive-thirdparty\.googleusercontent\.com\/(?:128|16)\/type\/([^"/]+\/[^"/]+)[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g

    const tracks: TrackData[] = []
    const seen = new Set<string>()
    let match = entryRegex.exec(html)
    while (match !== null) {
      const fileId = match[2]
      const mime = this._decodeHtmlEntities(match[3] || '')
      if (
        fileId &&
        !seen.has(fileId) &&
        (mime.startsWith('audio/') || mime.startsWith('video/'))
      ) {
        const rawTitle = this._decodeHtmlEntities(match[4] || '')
        const title = rawTitle || `Google Drive File ${fileId}`

        const trackInfo: TrackInfo = {
          identifier: fileId,
          isSeekable: true,
          author: 'Google Drive',
          length: 0,
          isStream: false,
          position: 0,
          title,
          uri: `https://drive.google.com/file/d/${fileId}/view`,
          artworkUrl: `https://lh3.googleusercontent.com/d/${fileId}`,
          isrc: null,
          sourceName: 'googledrive'
        }

        tracks.push({
          encoded: encodeTrack({
            ...trackInfo,
            details: []
          } as TrackEncodeInput),
          info: trackInfo,
          pluginInfo: {}
        })
        seen.add(fileId)
      }
      match = entryRegex.exec(html)
    }

    if (tracks.length === 0) return null
    return { title: folderTitle, tracks }
  }

  public async resolve(url: string): Promise<SourceResult> {
    const folderPattern = this.patterns[2]
    const folderMatch = folderPattern ? url.match(folderPattern) : null
    if (folderMatch?.[1]) {
      return this._resolveFolder(folderMatch[1], url)
    }

    const filePattern1 = this.patterns[0]
    const filePattern2 = this.patterns[1]
    const idMatch =
      (filePattern1 ? url.match(filePattern1) : null) ||
      (filePattern2 ? url.match(filePattern2) : null)
    if (!idMatch?.[1]) return { loadType: 'empty', data: null }

    const fileId = idMatch[1]
    const info = await this._getFileInfo(fileId, url)

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack({ ...info, details: [] } as TrackEncodeInput),
        info,
        pluginInfo: {}
      }
    }
  }

  private async _getFileInfo(fileId: string, url: string): Promise<TrackInfo> {
    const origin = 'https://drive.google.com'
    const { cookieHeader, authHeader } = await this._getCookiesAndAuthHeader(
      url,
      origin
    )

    const headers: Record<string, string> = {
      Referer: 'https://drive.google.com/',
      Origin: origin,
      'User-Agent': this.userAgent
    }
    if (authHeader) headers.Authorization = authHeader
    if (cookieHeader) headers.Cookie = cookieHeader

    const apiUrl = `https://content-workspacevideo-pa.googleapis.com/v1/drive/media/${fileId}/playback?key=${this.apiKey}`
    const response = await makeRequest(apiUrl, {
      method: 'GET',
      headers
    })

    const body = response.body as GoogleDrivePlaybackResponse | undefined
    let title = 'Unknown Drive File'
    let durationMs = 0

    if (!response.error && body?.mediaMetadata) {
      const metadataTitle = body.mediaMetadata.title
        ? this._normalizeDriveTitle(body.mediaMetadata.title)
        : ''
      if (metadataTitle) title = metadataTitle
      durationMs = body.mediaMetadata.duration
        ? Math.round(parseFloat(body.mediaMetadata.duration) * 1000)
        : 0
    }

    try {
      const probeHeaders: Record<string, string> = {
        'User-Agent': this.userAgent,
        Referer: 'https://drive.google.com/'
      }
      if (cookieHeader) probeHeaders.Cookie = cookieHeader

      const probe = await http1makeRequest(
        `https://drive.google.com/uc?id=${fileId}&export=download&authuser=0`,
        {
          method: 'GET',
          headers: probeHeaders,
          maxRedirects: 10,
          streamOnly: true
        }
      )

      const dispositionHeader = probe.headers?.['content-disposition']
      const disposition =
        (Array.isArray(dispositionHeader)
          ? dispositionHeader[0]
          : dispositionHeader) || ''
      const filenameFromDisposition =
        this._extractFilenameFromContentDisposition(String(disposition))
      if (filenameFromDisposition) {
        title = filenameFromDisposition
      }
      ;(probe.stream as Readable | undefined)?.destroy?.()
    } catch {}

    if (title === 'Unknown Drive File') {
      const downloadPage = await makeRequest(
        `https://drive.google.com/uc?id=${fileId}&export=download`,
        {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent, Cookie: cookieHeader }
        }
      )
      if (typeof downloadPage.body === 'string') {
        const titleMatch = downloadPage.body.match(/<title>(.*?)<\/title>/)
        const htmlTitle = titleMatch?.[1]
          ? this._normalizeDriveTitle(titleMatch[1])
          : ''
        if (htmlTitle) title = htmlTitle
      }
    }

    return {
      identifier: fileId,
      isSeekable: true,
      author: 'Google Drive',
      length: durationMs,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: `https://lh3.googleusercontent.com/d/${fileId}`,
      isrc: null,
      sourceName: 'googledrive'
    }
  }

  private async _resolveFolder(
    folderId: string,
    url: string
  ): Promise<SourceResult> {
    try {
      const embeddedResult = await this._resolveFolderViaEmbedded(folderId)
      if (embeddedResult) {
        return {
          loadType: 'playlist',
          data: {
            info: { name: embeddedResult.title, selectedTrack: 0 },
            tracks: embeddedResult.tracks,
            pluginInfo: {}
          }
        }
      }

      const origin = 'https://drive.google.com'
      const { cookieHeader, authHeader } = await this._getCookiesAndAuthHeader(
        url,
        origin
      )

      const webpage = await makeRequest(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Language': 'en-US,en;q=0.5',
          Cookie: cookieHeader
        }
      })
      if (typeof webpage.body !== 'string')
        throw new Error('Failed to load folder page')

      const keyMatch = webpage.body.match(/"(\w{39})"/)
      if (!keyMatch) throw new Error('API Key not found in folder page')
      const key = keyMatch[1]

      const boundary = '=====vc17a3rwnndj====='
      const fields =
        'kind%2CnextPageToken%2Citems(kind%2CmodifiedDate%2CmodifiedByMeDate%2ClastViewedByMeDate%2CfileSize%2Cowners(kind%2CpermissionId%2Cid)%2ClastModifyingUser(kind%2CpermissionId%2Cid)%2ChasThumbnail%2CthumbnailVersion%2Ctitle%2Cid%2CresourceKey%2Cshared%2CsharedWithMeDate%2CuserPermission(role)%2CexplicitlyTrashed%2CmimeType%2CquotaBytesUsed%2Ccopyable%2CfileExtension%2CsharingUser(kind%2CpermissionId%2Cid)%2Cspaces%2Cversion%2CteamDriveId%2ChasAugmentedPermissions%2CcreatedDate%2CtrashingUser(kind%2CpermissionId%2Cid)%2CtrashedDate%2Cparents(id)%2CshortcutDetails(targetId%2CtargetMimeType%2CtargetLookupStatus)%2Ccapabilities(canCopy%2CcanDownload%2CcanEdit%2CcanAddChildren%2CcanDelete%2CcanRemoveChildren%2CcanShare%2CcanTrash%2CcanRename%2CcanReadTeamDrive%2CcanMoveTeamDriveItem)%2Clabels(starred%2Ctrashed%2Crestricted%2Cviewed))%2CincompleteSearch'

      let pageToken = ''
      const tracks: TrackData[] = []
      let title = 'Google Drive Folder'

      const titleMatch = webpage.body.match(/<title>(.*?)<\/title>/)
      if (titleMatch?.[1])
        title = titleMatch[1].replace(' - Google Drive', '').trim()

      while (pageToken !== null) {
        const requestPath = `/drive/v2beta/files?openDrive=true&reason=102&syncType=0&errorRecovery=false&q=trashed%20%3D%20false%20and%20'${folderId}'%20in%20parents&fields=${fields}&appDataFilter=NO_APP_DATA&spaces=drive&pageToken=${pageToken}&maxResults=50&supportsTeamDrives=true&includeItemsFromAllDrives=true&corpora=default&orderBy=folder%2Ctitle_natural%20asc&retryCount=0&key=${key} HTTP/1.1`
        const requestBody = `--${boundary}\r\ncontent-type: application/http\r\ncontent-transfer-encoding: binary\r\n\r\nGET ${requestPath}\r\n\r\n--${boundary}--\r\n`

        const ctParam = encodeURIComponent(
          `multipart/mixed; boundary="${boundary}"`
        )
        const batchUrl = `https://clients6.google.com/batch/drive/v2beta?key=${key}&$ct=${ctParam}`

        const reqHeaders: Record<string, string> = {
          'Content-Type': `multipart/mixed; boundary="${boundary}"`,
          Origin: origin,
          'User-Agent': this.userAgent,
          'Accept-Language': 'en-US,en;q=0.5'
        }

        if (authHeader) reqHeaders.Authorization = authHeader
        if (cookieHeader) reqHeaders.Cookie = cookieHeader

        const batchResponse = await makeRequest(batchUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: requestBody
        })

        if (typeof batchResponse.body !== 'string')
          throw new Error('Invalid batch response')

        const jsonMatch = batchResponse.body.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
          if (batchResponse.body.includes('400 Bad Request')) {
            throw new Error(
              'Google Drive API rejected batch request (400 Bad Request). Are cookies properly configured?'
            )
          }
          throw new Error('No JSON found in batch response')
        }

        const data = JSON.parse(jsonMatch[0])
        if (data.error)
          throw new Error(data.error.message || 'Unknown API error')

        for (const item of data.items || []) {
          if (
            item.mimeType?.startsWith('audio/') ||
            item.mimeType?.startsWith('video/')
          ) {
            const trackInfo = {
              identifier: item.id,
              isSeekable: true,
              author: 'Google Drive',
              length: 0,
              isStream: false,
              position: 0,
              title: item.title,
              uri: `https://drive.google.com/file/d/${item.id}/view`,
              artworkUrl: item.hasThumbnail
                ? `https://lh3.googleusercontent.com/d/${item.id}`
                : 'https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
              isrc: null,
              sourceName: 'googledrive'
            }
            tracks.push({
              encoded: encodeTrack({
                ...trackInfo,
                details: []
              } as TrackEncodeInput),
              info: trackInfo,
              pluginInfo: {}
            })
          }
        }
        pageToken = data.nextPageToken || null
      }

      return {
        loadType: 'playlist',
        data: {
          info: { name: title, selectedTrack: 0 },
          tracks,
          pluginInfo: {}
        }
      }
    } catch (err) {
      return {
        loadType: 'error',
        exception: {
          message: `Folder resolution failed: ${(err as Error).message}`,
          severity: 'common'
        }
      }
    }
  }

  public async getTrackUrl(trackInfo: TrackInfo): Promise<TrackUrlResult> {
    const fileId = trackInfo.identifier
    const finalUrl = `https://drive.google.com/uc?id=${fileId}&export=download&authuser=0`
    const format = this._getFormat(undefined, trackInfo.title) || 'mp3'
    return {
      url: finalUrl,
      format
    }
  }

  public async loadStream(
    _track: TrackInfo,
    url: string,
    _protocol?: string,
    additionalData?: Record<string, unknown>
  ): Promise<TrackStreamResult> {
    const { cookieHeader } = await this._getCookiesAndAuthHeader(
      `https://drive.google.com/file/d/${_track.identifier}/view`,
      'https://drive.google.com'
    )

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Referer: 'https://drive.google.com/'
    }
    if (cookieHeader) headers.Cookie = cookieHeader

    let request = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      maxRedirects: 10,
      headers
    })

    if (request.error || !request.stream) {
      return {
        exception: {
          message: `Drive stream error: ${request.error}`,
          severity: 'fault'
        }
      }
    }

    if ((request.statusCode || 0) >= 400) {
      return {
        exception: {
          message: `Drive returned status ${request.statusCode}`,
          severity: 'common'
        }
      }
    }

    let contentType = (request.headers?.['content-type'] as string) || ''
    let stream = request.stream as Readable
    let streamType =
      contentType || this._getFormat(contentType, _track.title) || 'mp3'

    if (contentType.includes('text/html')) {
      const htmlResponse = await makeRequest(request.finalUrl || url, {
        method: 'GET',
        headers
      })
      stream.destroy?.()

      if (typeof htmlResponse.body === 'string') {
        const confirmToken = this._extractDriveConfirmToken(htmlResponse.body)
        if (confirmToken) {
          const confirmedUrl = `https://drive.usercontent.google.com/download?id=${_track.identifier}&export=download&confirm=${confirmToken}&authuser=0`
          request = await http1makeRequest(confirmedUrl, {
            method: 'GET',
            streamOnly: true,
            maxRedirects: 10,
            headers
          })
          if (request.error || !request.stream) {
            return {
              exception: {
                message: `Drive stream error: ${request.error}`,
                severity: 'fault'
              }
            }
          }
          if ((request.statusCode || 0) >= 400) {
            return {
              exception: {
                message: `Drive returned status ${request.statusCode}`,
                severity: 'common'
              }
            }
          }

          const confirmedType =
            (request.headers?.['content-type'] as string) || ''
          if (confirmedType.includes('text/html')) {
            ;(request.stream as Readable | undefined)?.destroy?.()
            return {
              exception: {
                message: 'Failed to bypass Drive confirmation (received HTML)',
                severity: 'common'
              }
            }
          }

          stream = request.stream as Readable
          contentType = confirmedType
          streamType =
            contentType ||
            this._getFormat(confirmedType, _track.title) ||
            streamType
        } else {
          return {
            exception: {
              message: 'Failed to bypass Drive confirmation (missing token)',
              severity: 'common'
            }
          }
        }
      } else {
        return {
          exception: {
            message:
              'Failed to bypass Drive confirmation (invalid HTML response)',
            severity: 'common'
          }
        }
      }
    }

    const finalStream = new PassThrough()
    const maxId3SkipBytes = 16 * 1024 * 1024
    let headerParsed = false
    let bytesToSkip = 0
    let pendingHeader: Buffer = Buffer.alloc(0)
    let totalSourceBytesRead = 0
    let activeStreamUrl = request.finalUrl || url
    let currentStream: Readable | null = null
    let reconnecting = false
    let streamEnded = false
    let reconnectStreak = 0
    const guildId = String(additionalData?.guildId || 'unbound')
    const streamContext = `guildId=${guildId} trackId=${_track.identifier} title="${String(_track.title || '-').replace(/"/g, "'")}"`

    const wait = async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, ms)
        timeout.unref?.()
      })
    }

    const onData = (chunk: Buffer): void => {
      totalSourceBytesRead += chunk.length
      if (reconnectStreak > 0) reconnectStreak = 0
      let chunkToWrite = chunk

      if (!headerParsed) {
        if (pendingHeader.length > 0) {
          chunkToWrite = Buffer.concat([pendingHeader, chunk])
          pendingHeader = Buffer.alloc(0)
        }

        if (chunkToWrite.length < 10) {
          pendingHeader = chunkToWrite
          return
        }

        if (
          chunkToWrite[0] === 0x49 &&
          chunkToWrite[1] === 0x44 &&
          chunkToWrite[2] === 0x33
        ) {
          const tagSize = this._readSynchsafeInt(chunkToWrite.subarray(6, 10))
          bytesToSkip = Math.min(10 + tagSize, maxId3SkipBytes)
          logger(
            'debug',
            'GoogleDrive',
            `[${streamContext}] skipping initial ID3 tag bytes=${bytesToSkip} url=${url}`
          )
        }

        headerParsed = true
      }

      if (bytesToSkip > 0) {
        if (chunkToWrite.length <= bytesToSkip) {
          bytesToSkip -= chunkToWrite.length
          return
        }
        chunkToWrite = chunkToWrite.subarray(bytesToSkip)
        bytesToSkip = 0
      }

      if (chunkToWrite.length === 0) return

      const shouldContinue = finalStream.write(chunkToWrite)
      if (!shouldContinue) currentStream?.pause()
    }

    const onEnd = (): void => {
      streamEnded = true
      if (pendingHeader.length > 0) {
        finalStream.write(pendingHeader)
        pendingHeader = Buffer.alloc(0)
      }
      logger(
        'debug',
        'GoogleDrive',
        `[${streamContext}] stream ended url=${url}, emitting finishBuffering`
      )
      finalStream.emit('finishBuffering')
      finalStream.end()
    }

    const onError = (err: Error): void => {
      const netErr = err as NodeJS.ErrnoException
      const message = err.message || String(err)
      const isBenignAbort =
        netErr.code === 'ECONNRESET' || /aborted|socket hang up/i.test(message)

      if (isBenignAbort) {
        void tryReconnect(message)
        return
      }

      logger(
        'error',
        'GoogleDrive',
        `[${streamContext}] stream error: ${message}`
      )
      finalStream.destroy(err)
    }

    const detachCurrent = (): void => {
      if (!currentStream) return
      currentStream.removeListener('data', onData)
      currentStream.removeListener('end', onEnd)
      currentStream.removeListener('error', onError)
    }

    const attachStream = (nextStream: Readable): void => {
      detachCurrent()
      currentStream = nextStream
      nextStream.on('data', onData)
      nextStream.on('end', onEnd)
      nextStream.on('error', onError)
    }

    const tryReconnect = async (reason: string): Promise<void> => {
      if (streamEnded || finalStream.destroyed || finalStream.writableEnded)
        return
      if (reconnecting) return
      reconnecting = true

      while (
        !streamEnded &&
        !finalStream.destroyed &&
        !finalStream.writableEnded
      ) {
        reconnectStreak++
        const delayMs = Math.min(
          300 * 2 ** Math.min(reconnectStreak - 1, 5),
          5000
        )
        logger(
          'debug',
          'GoogleDrive',
          `[${streamContext}] disconnected reason=${reason} retry=${reconnectStreak} offset=${totalSourceBytesRead} delayMs=${delayMs} url=${activeStreamUrl}`
        )
        await wait(delayMs)

        if (streamEnded || finalStream.destroyed || finalStream.writableEnded)
          break

        const reconnectHeaders: Record<string, string> = {
          ...headers,
          Range: `bytes=${totalSourceBytesRead}-`
        }
        const resumed = await http1makeRequest(activeStreamUrl, {
          method: 'GET',
          streamOnly: true,
          maxRedirects: 10,
          headers: reconnectHeaders
        })

        if (resumed.statusCode === 416) {
          finalStream.emit('finishBuffering')
          finalStream.end()
          break
        }

        if (
          !resumed.error &&
          resumed.stream &&
          (resumed.statusCode || 0) < 400
        ) {
          activeStreamUrl = resumed.finalUrl || activeStreamUrl
          attachStream(resumed.stream as Readable)
          reconnecting = false
          return
        }

        logger(
          'debug',
          'GoogleDrive',
          `[${streamContext}] reconnect failed url=${activeStreamUrl} statusOrError=${resumed.error || resumed.statusCode}`
        )

        if (resumed.statusCode === 403 || resumed.statusCode === 404) {
          const refreshed = await this.getTrackUrl(_track)
          if (refreshed.url) {
            activeStreamUrl = refreshed.url
          }
        }
      }

      reconnecting = false
    }

    finalStream.on('drain', () => {
      currentStream?.resume()
    })
    finalStream.on('close', () => {
      detachCurrent()
      currentStream?.destroy?.()
    })

    attachStream(stream)

    return { stream: finalStream, type: streamType }
  }

  public async search(): Promise<SourceResult> {
    return { loadType: 'empty', data: null }
  }
}
