import { parseTtmlLyrics } from '../modules/ttmlLyrics.ts'
import type {
  LyricsResult,
  TrackInfo
} from '../typings/lyrics/musixmatch.types.ts'
import type { HttpProxyConfig } from '../typings/utils.types.ts'
import { logger, makeRequest } from '../utils.ts'

type Payload = {
  success?: boolean
  data?: {
    song?: string
    artist?: string
    lyrics?: string
    format?: string
    syncType?: string
    videoId?: string
    submitter?: { displayName?: string; keyId?: string }
  }
}
type Context = {
  options: { lyrics?: Record<string, unknown> }
  proxyManager?: {
    getBestProxy: (
      sourceName: string
    ) => { target?: HttpProxyConfig } | undefined
    report?: (url: string, success: boolean, statusCode: number) => void
  }
}
type ProxyConfig = HttpProxyConfig | string

export default class UnisonLyrics {
  private readonly nodelink: Context
  private proxyIndex = 0

  constructor(nodelink: Context) {
    this.nodelink = nodelink
  }

  private _getProxy(): HttpProxyConfig | undefined {
    const sourceConfig = this.nodelink.options.lyrics?.unison
    const custom =
      typeof sourceConfig === 'object' && sourceConfig !== null
        ? (sourceConfig as { proxy?: ProxyConfig | ProxyConfig[] }).proxy
        : undefined
    if (Array.isArray(custom)) {
      if (custom.length === 0) return undefined
      const item = custom[this.proxyIndex % custom.length]
      this.proxyIndex = (this.proxyIndex + 1) % custom.length
      return typeof item === 'string' ? { url: item } : item
    }
    if (typeof custom === 'string') return { url: custom }
    if (custom) return custom
    return this.nodelink.proxyManager?.getBestProxy('unison')?.target
  }

  private _reportProxy(
    proxy: HttpProxyConfig | undefined,
    success: boolean,
    statusCode: number
  ): void {
    if (proxy?.url)
      this.nodelink.proxyManager?.report?.(proxy.url, success, statusCode)
  }

  async setup(): Promise<boolean> {
    return true
  }

  async getLyrics(track: TrackInfo): Promise<LyricsResult> {
    const params = new URLSearchParams()
    if (
      track.identifier &&
      ['youtube', 'ytmusic'].includes(track.sourceName ?? '')
    )
      params.set('v', track.identifier)
    else if (track.isrc) params.set('isrc', track.isrc)
    else {
      params.set('song', track.title)
      params.set('artist', track.author)
    }
    const proxy = this._getProxy()
    try {
      const response = await makeRequest(
        `https://unison.betterlyrics.org/lyrics?${params}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          },
          proxy,
          network: proxy ? { proxy } : undefined
        }
      )
      this._reportProxy(
        proxy,
        response.statusCode === 200,
        response.statusCode ?? 0
      )
      if (response.error || response.statusCode !== 200)
        return { loadType: 'empty', data: {} }
      const payload = (
        typeof response.body === 'string'
          ? JSON.parse(response.body)
          : response.body
      ) as Payload
      const data = payload.data
      if (!payload.success || !data?.lyrics)
        return { loadType: 'empty', data: {} }
      const { lines, synced } = /ttml/i.test(data.format ?? '')
        ? parseTtmlLyrics(data.lyrics)
        : { lines: [], synced: false }
      if (!lines.length) return { loadType: 'empty', data: {} }
      const songUrl = `https://unison.betterlyrics.org/song/${encodeURIComponent(data.videoId ?? track.identifier ?? '')}`
      const submitter = data.submitter?.keyId
        ? {
            name: data.submitter.displayName ?? 'Unison contributor',
            url: `https://unison.betterlyrics.org/curator/${encodeURIComponent(data.submitter.keyId)}`
          }
        : undefined
      return {
        loadType: 'lyrics',
        data: {
          name: data.song ?? track.title,
          synced,
          lines,
          attribution: {
            name: 'Unison',
            url: songUrl,
            ...(submitter ? { submitter } : {})
          }
        }
      }
    } catch (error) {
      logger(
        'debug',
        'Lyrics',
        `Unison lookup failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return { loadType: 'empty', data: {} }
    }
  }
}
