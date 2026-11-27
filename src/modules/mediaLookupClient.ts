type MediaRequest = (url: string, init: RequestInit) => Promise<Response>

/** Bounded, opt-in external metadata requests. No playback or media proxying. */
export class MediaLookupClient {
  private readonly cache = new Map<string, { until: number; value: unknown }>()
  private busy = false
  private nextRequest = 0

  private readonly request: MediaRequest

  constructor(request: MediaRequest = fetch) {
    this.request = request
  }

  async lookup<T>(
    key: string,
    url: string,
    headers: Record<string, string>,
    normalize: (data: unknown) => T | null
  ): Promise<{
    status: number
    data: T | null
    reason?: string
    upstreamStatus?: number
  }> {
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached && cached.until > now)
      return { status: 200, data: cached.value as T }
    if (cached) this.cache.delete(key)
    if (this.busy || now < this.nextRequest)
      return { status: 429, data: null, reason: 'local-rate-limit' }
    this.busy = true
    this.nextRequest = now + 1100
    try {
      const response = await this.request(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get('retry-after')
          const seconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry)
              : retry && Number.isFinite(Date.parse(retry))
                ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
                : 60
          this.nextRequest = Math.max(
            this.nextRequest,
            Date.now() + Math.min(3600, Math.max(1, seconds)) * 1000
          )
        }
        return {
          status: response.status === 404 ? 404 : 502,
          data: null,
          reason: 'upstream-http',
          upstreamStatus: response.status
        }
      }
      const reader = response.body?.getReader()
      if (!reader) return { status: 502, data: null, reason: 'missing-body' }
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 1024 * 1024) {
            await reader.cancel()
            return { status: 502, data: null, reason: 'response-too-large' }
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return { status: 502, data: null, reason: 'invalid-json' }
      }
      const data = normalize(payload)
      if (data === null)
        return {
          status: 502,
          data: null,
          reason: 'unexpected-provider-payload'
        }
      if (this.cache.size >= 256) {
        const first = this.cache.keys().next().value
        if (first !== undefined) this.cache.delete(first)
      }
      this.cache.set(key, { until: Date.now() + 3600000, value: data })
      return { status: 200, data }
    } catch (error) {
      const timeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      return {
        status: 502,
        data: null,
        reason: timeout ? 'timeout' : 'request-failed'
      }
    } finally {
      this.busy = false
    }
  }
}
