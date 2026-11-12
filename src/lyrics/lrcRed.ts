import type {
  LyricsLine,
  LyricsResult,
  TrackInfo
} from '../typings/lyrics/musixmatch.types.ts'
import type { HttpProxyConfig } from '../typings/utils.types.ts'
import { logger, makeRequest } from '../utils.ts'

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
type Hit = { isrc?: string; title?: string; artist?: string }
type SearchPayload = { hits?: Hit[] }
type Detail = {
  isrc?: string
  title?: string
  files?: { ttml?: string }
  page?: string
}

export default class LrcRedLyrics {
  private readonly nodelink: Context
  private proxyIndex = 0

  constructor(nodelink: Context) {
    this.nodelink = nodelink
  }

  private _getProxy(): HttpProxyConfig | undefined {
    const sourceConfig = this.nodelink.options.lyrics?.lrcRed
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
    return this.nodelink.proxyManager?.getBestProxy('lrcRed')?.target
  }

  private _reportProxy(
    proxy: HttpProxyConfig | undefined,
    success: boolean,
    statusCode: number
  ): void {
    if (proxy?.url)
      this.nodelink.proxyManager?.report?.(proxy.url, success, statusCode)
  }

  private _parseTtml(ttml: string): LyricsLine[] {
    const decode = (value: string): string =>
      value.replace(
        /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
        (entity, token: string) => {
          const named: Record<string, string> = {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'"
          }
          if (token[0] !== '#') return named[token.toLowerCase()] ?? entity
          const code =
            token[1]?.toLowerCase() === 'x'
              ? Number.parseInt(token.slice(2), 16)
              : Number.parseInt(token.slice(1), 10)
          return Number.isFinite(code) ? String.fromCodePoint(code) : entity
        }
      )
    const timeMs = (value?: string): number | null => {
      if (!value) return null
      const raw = value.trim()
      if (/^\d+(?:\.\d+)?ms$/i.test(raw))
        return Math.round(Number.parseFloat(raw))
      if (/^\d+(?:\.\d+)?s$/i.test(raw))
        return Math.round(Number.parseFloat(raw) * 1000)
      const parts = raw.split(':').map(Number)
      if (parts.some((part) => !Number.isFinite(part))) return null
      const [hoursOrMinutes, minutesOrSeconds, seconds] = parts
      if (
        parts.length === 2 &&
        hoursOrMinutes !== undefined &&
        minutesOrSeconds !== undefined
      )
        return Math.round((hoursOrMinutes * 60 + minutesOrSeconds) * 1000)
      if (
        parts.length === 3 &&
        hoursOrMinutes !== undefined &&
        minutesOrSeconds !== undefined &&
        seconds !== undefined
      )
        return Math.round(
          (hoursOrMinutes * 3600 + minutesOrSeconds * 60 + seconds) * 1000
        )
      return null
    }
    const lines: LyricsLine[] = []
    const paragraphs = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
    let paragraph = paragraphs.exec(ttml)
    while (paragraph) {
      const attrs = paragraph[1] ?? ''
      const body = paragraph[2] ?? ''
      const start = timeMs(attrs.match(/\bbegin=["']([^"']+)["']/i)?.[1]) ?? 0
      const end = timeMs(attrs.match(/\bend=["']([^"']+)["']/i)?.[1])
      const words: Array<{ text: string; time: number; duration: number }> = []
      let text = ''
      let cursor = 0
      const spans = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi
      let span = spans.exec(body)
      while (span) {
        text += decode(body.slice(cursor, span.index).replace(/<[^>]+>/g, ''))
        const wordText = decode((span[2] ?? '').replace(/<[^>]+>/g, '')).trim()
        const spanAttrs = span[1] ?? ''
        const wordStart = timeMs(
          spanAttrs.match(/\bbegin=["']([^"']+)["']/i)?.[1]
        )
        const wordEnd = timeMs(spanAttrs.match(/\bend=["']([^"']+)["']/i)?.[1])
        if (wordText) {
          text += wordText
          if (wordStart !== null)
            words.push({
              text: wordText,
              time: wordStart,
              duration: wordEnd === null ? 0 : Math.max(0, wordEnd - wordStart)
            })
        }
        cursor = span.index + span[0].length
        span = spans.exec(body)
      }
      text += decode(body.slice(cursor).replace(/<[^>]+>/g, ''))
      text = text.replace(/\s+/g, ' ').trim()
      if (text)
        lines.push({
          text,
          time: start,
          duration: end === null ? 0 : Math.max(0, end - start),
          ...(words.length ? { words } : {})
        })
      paragraph = paragraphs.exec(ttml)
    }
    return lines.sort((left, right) => left.time - right.time)
  }

  async setup(): Promise<boolean> {
    return true
  }

  async getLyrics(track: TrackInfo): Promise<LyricsResult> {
    const proxy = this._getProxy()
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    const request = async (url: string, referer = 'https://lrc.red/') =>
      makeRequest(url, {
        method: 'GET',
        headers: { ...headers, Referer: referer },
        proxy,
        network: proxy ? { proxy } : undefined
      })
    try {
      let isrc = track.isrc?.trim()
      if (!isrc) {
        const q = encodeURIComponent(`${track.author} ${track.title}`)
        const search = await request(`https://lrc.red/search.json?q=${q}`)
        if (search.error || search.statusCode !== 200) {
          this._reportProxy(proxy, false, search.statusCode ?? 0)
          return { loadType: 'empty', data: {} }
        }
        this._reportProxy(proxy, true, search.statusCode ?? 200)
        const payload = (
          typeof search.body === 'string'
            ? JSON.parse(search.body)
            : search.body
        ) as SearchPayload
        const hits = payload.hits ?? []
        const norm = (s: string | undefined) =>
          (s ?? '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim()
        const best =
          hits.find(
            (hit) =>
              norm(hit.title) === norm(track.title) &&
              norm(hit.artist) === norm(track.author)
          ) ?? hits.find((hit) => norm(hit.title) === norm(track.title))
        isrc = best?.isrc
      }
      if (!isrc) return { loadType: 'empty', data: {} }
      const pageUrl = `https://lrc.red/s/${encodeURIComponent(isrc)}`
      const detailResponse = await request(`${pageUrl}.json`, pageUrl)
      if (detailResponse.error || detailResponse.statusCode !== 200) {
        this._reportProxy(proxy, false, detailResponse.statusCode ?? 0)
        return { loadType: 'empty', data: {} }
      }
      this._reportProxy(proxy, true, detailResponse.statusCode ?? 200)
      const detail = (
        typeof detailResponse.body === 'string'
          ? JSON.parse(detailResponse.body)
          : detailResponse.body
      ) as Detail
      if (!detail.files?.ttml) return { loadType: 'empty', data: {} }
      const lyricsResponse = await request(detail.files.ttml, pageUrl)
      if (
        lyricsResponse.error ||
        lyricsResponse.statusCode !== 200 ||
        typeof lyricsResponse.body !== 'string'
      ) {
        this._reportProxy(proxy, false, lyricsResponse.statusCode ?? 0)
        return { loadType: 'empty', data: {} }
      }
      this._reportProxy(proxy, true, lyricsResponse.statusCode ?? 200)
      const lines = this._parseTtml(lyricsResponse.body)
      if (!lines.length) return { loadType: 'empty', data: {} }
      return {
        loadType: 'lyrics',
        data: {
          name: detail.title ?? track.title,
          synced: true,
          lines,
          attribution: {
            name: 'lrc.red',
            url: detail.page ?? `https://lrc.red/s/${encodeURIComponent(isrc)}`
          }
        }
      }
    } catch (error) {
      logger(
        'debug',
        'Lyrics',
        `lrc.red lookup failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return { loadType: 'empty', data: {} }
    }
  }
}
