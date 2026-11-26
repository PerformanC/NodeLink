import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchPathfinderCanvas, normalizePathfinderCanvas } from './spotifyPathfinderCanvas.ts'

const trackUri = 'spotify:track:example'
const url = 'https://canvaz.scdn.co/example.mp4'
const payload = { data: { trackUnion: { uri: trackUri, canvas: { url, uri: 'spotify:canvas:abc' } } } }

test('normalizes a matching single-track Canvas', () => {
  const value = normalizePathfinderCanvas(payload, trackUri)
  assert.equal(value.outcome, 'found')
  assert.equal(value.result?.data.canvasesList[0]?.canvasUrl, url)
  assert.equal(value.result?.data.canvasesList[0]?.trackUri, trackUri)
})

test('rejects mismatches, unsafe URLs and distinguishes absent Canvas from errors', () => {
  assert.equal(normalizePathfinderCanvas(payload, 'spotify:track:wrong').outcome, 'unexpected-payload')
  assert.equal(normalizePathfinderCanvas({ data: { trackUnion: { canvas: { url: 'https://unrelated.example/video' } } } }, trackUri).outcome, 'unexpected-payload')
  assert.equal(normalizePathfinderCanvas({ data: { trackUnion: { canvas: null } } }, trackUri).outcome, 'missing-canvas')
  assert.equal(normalizePathfinderCanvas({ errors: [{ message: 'private' }] }, trackUri).outcome, 'graphql-error')
})

test('does not retry access rejection or disclose response body', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('private', { status: 403 }))
  const events: unknown[] = []
  assert.equal(await fetchPathfinderCanvas(trackUri, 'secret', e => events.push(e)), null)
  assert.equal(request.mock.callCount(), 1)
  assert.deepEqual(events, [{ kind: 'pathfinder', outcome: 'http-error', status: 403 }])
})

test('accepts existing credentials only and parses successful GraphQL responses', async (t) => {
  let init: RequestInit | undefined
  const request = t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    init = options
    return new Response(JSON.stringify(payload))
  })
  assert.equal(await fetchPathfinderCanvas(trackUri, null), null)
  assert.equal(request.mock.callCount(), 0)
  assert.equal((await fetchPathfinderCanvas(trackUri, 'secret'))?.data.canvasesList[0]?.canvasUrl, url)
  assert.equal(init?.redirect, 'error')
  assert.equal(JSON.parse(String(init?.body)).variables.trackUri, trackUri)
  assert.equal(new Headers(init?.headers).has('client-token'), false)
})

test('distinguishes explicit null from a Canvas with an identifier but no URL', async (t) => {
  const absent = { data: { trackUnion: { canvas: null } } }
  const uriOnly = { data: { trackUnion: { canvas: { uri: 'spotify:canvas:abc', url: null } } } }
  assert.deepEqual(normalizePathfinderCanvas(absent, trackUri), { outcome: 'missing-canvas', canvasState: 'null', result: null })
  assert.deepEqual(normalizePathfinderCanvas(uriOnly, trackUri), { outcome: 'canvas-without-url', canvasState: 'uri-only', result: null })
  assert.deepEqual(normalizePathfinderCanvas({ data: { trackUnion: { canvas: {} } } }, trackUri), { outcome: 'canvas-without-url', canvasState: 'no-url', result: null })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(uriOnly)))
  const events: unknown[] = []
  assert.equal(await fetchPathfinderCanvas(trackUri, 'secret', event => events.push(event)), null)
  assert.deepEqual(events, [{ kind: 'pathfinder', outcome: 'canvas-without-url', status: 200, canvasState: 'uri-only' }])
})

// Synthetic values matching the observed browser response structure; no captured credentials or URLs.
test('preserves the complete Pathfinder Canvas metadata shape', () => {
  const fileId = '0123456789abcdef0123456789abcdef'
  const canvasUri = 'spotify:canvas:abcdefghijklmnopqrstuv'
  const value = normalizePathfinderCanvas({ data: { trackUnion: {
    __typename: 'Track', uri: trackUri, canvas: { fileId, type: 'VIDEO_LOOPING_RANDOM', uri: canvasUri, url }
  } } }, trackUri)
  assert.deepEqual(value.result?.data.canvasesList[0], {
    id: 'abcdefghijklmnopqrstuv', canvasUrl: url, trackUri, canvasUri, fileId,
    type: 'VIDEO_LOOPING_RANDOM', artist: { artistUri: '', artistName: '', artistImgUrl: '' }
  })
})

test('omits malformed optional Canvas identifiers and playback types', () => {
  const value = normalizePathfinderCanvas({ data: { trackUnion: { uri: trackUri, canvas: { url, fileId: 'bad', type: 'invalid type', uri: {} } } } }, trackUri)
  const entry = value.result?.data.canvasesList[0]
  assert.equal(entry?.canvasUrl, url)
  assert.equal(entry?.fileId, undefined)
  assert.equal(entry?.type, undefined)
  assert.equal(entry?.canvasUri, '')
})
