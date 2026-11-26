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
