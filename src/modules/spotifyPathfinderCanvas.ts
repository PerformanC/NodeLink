import type { SpotifyCanvasFetchResult } from '../typings/modules/spotifyCanvas.types.ts'

type Diagnostic = {
  kind: 'pathfinder'
  outcome: 'http-error' | 'graphql-error' | 'missing-canvas' | 'canvas-without-url' | 'unexpected-payload' | 'found' | 'request-error' | 'missing-token'
  status?: number
  canvasState?: 'null' | 'uri-only' | 'no-url'
}
type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : undefined
}

/** Normalize a single-track GraphQL response without trusting unrelated track IDs. */
export function normalizePathfinderCanvas(payload: unknown, trackUri: string): {
  outcome: Diagnostic['outcome']
  canvasState?: Diagnostic['canvasState']
  result: SpotifyCanvasFetchResult | null
} {
  const root = record(payload)
  if (Array.isArray(root?.errors) && root.errors.length) return { outcome: 'graphql-error', result: null }
  const track = record(record(root?.data)?.trackUnion)
  if (!track || (track.uri !== undefined && track.uri !== trackUri)) return { outcome: 'unexpected-payload', result: null }
  if (track.canvas === null) return { outcome: 'missing-canvas', canvasState: 'null', result: null }
  const canvas = record(track.canvas)
  if (!canvas) return { outcome: 'unexpected-payload', result: null }
  if (typeof canvas.url !== 'string' || !canvas.url.trim()) {
    const hasUri = typeof canvas.uri === 'string' && canvas.uri.trim().length > 0
    return {
      outcome: 'canvas-without-url',
      canvasState: hasUri ? 'uri-only' : 'no-url',
      result: null
    }
  }
  try {
    const url = new URL(canvas.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(url.hostname === 'scdn.co' || url.hostname.endsWith('.scdn.co'))) {
      return { outcome: 'unexpected-payload', result: null }
    }
    const canvasUri = typeof canvas.uri === 'string' && /^spotify:canvas:[A-Za-z0-9]+$/.test(canvas.uri) ? canvas.uri : ''
    return {
      outcome: 'found',
      result: { data: { canvasesList: [{
        id: canvasUri ? canvasUri.split(':')[2] ?? '' : '',
        canvasUrl: url.href,
        trackUri,
        canvasUri,
        ...(typeof canvas.fileId === 'string' && /^[a-f0-9]{32}$/i.test(canvas.fileId) ? { fileId: canvas.fileId } : {}),
        ...(typeof canvas.type === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(canvas.type) ? { type: canvas.type } : {}),
        artist: { artistUri: '', artistName: '', artistImgUrl: '' }
      }] } }
    }
  } catch { return { outcome: 'unexpected-payload', result: null } }
}

/** Experimental, single request using an existing authorized session. No token generation or retry. */
export async function fetchPathfinderCanvas(
  trackUri: string,
  token: string | null,
  onDiagnostic?: (event: Diagnostic) => void,
  clientToken?: string
): Promise<SpotifyCanvasFetchResult | null> {
  if (!token) {
    onDiagnostic?.({ kind: 'pathfinder', outcome: 'missing-token' })
    return null
  }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    if (clientToken) headers['client-token'] = clientToken
    const response = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        operationName: 'canvas',
        variables: { trackUri },
        extensions: { persistedQuery: { version: 1, sha256Hash: '575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f' } }
      })
    })
    if (!response.ok) {
      await response.body?.cancel()
      onDiagnostic?.({ kind: 'pathfinder', outcome: 'http-error', status: response.status })
      return null
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing body')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 256 * 1024) {
          await reader.cancel()
          throw new Error('Response too large')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const { outcome, result, canvasState } = normalizePathfinderCanvas(JSON.parse(Buffer.concat(chunks).toString('utf8')), trackUri)
    onDiagnostic?.({ kind: 'pathfinder', outcome, status: response.status, ...(canvasState ? { canvasState } : {}) })
    return result
  } catch {
    onDiagnostic?.({ kind: 'pathfinder', outcome: 'request-error' })
    return null
  }
}
