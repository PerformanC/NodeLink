/** Validate Spotify-hosted Canvas references, without fetching the referenced video. */
export function spotifyCanvasUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !(url.hostname === 'scdn.co' || url.hostname.endsWith('.scdn.co'))
    )
      return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Bound decoded response size, even when Content-Length is absent or inaccurate. */
export async function readCanvasResponse(
  response: Response,
  limit: number
): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel()
    throw new Error('Canvas response too large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing Canvas response body')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new Error('Canvas response too large')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    reader.releaseLock()
  }
}

/** A missing or malformed optional type is unknown, not evidence of non-video media. */
export function spotifyCanvasType(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : undefined
}
