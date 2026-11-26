import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchCanvas, type CanvasDiagnostic } from './spotifyCanvas.ts'

const trackUri = 'spotify:track:abc'

test('reports HTTP failures without logging credentials or response body', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('private', { status: 401 }))
  const events: CanvasDiagnostic[] = []
  assert.equal(await fetchCanvas(trackUri, 'secret', (event) => events.push(event)), null)
  assert.deepEqual(events, [{ kind: 'http', status: 401 }])
})

test('distinguishes a successful empty response from an HTTP failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  assert.deepEqual(await fetchCanvas(trackUri, 'secret', (event) => events.push(event)), { data: { canvasesList: [] } })
  assert.deepEqual(events, [
    { kind: 'http', status: 200 },
    { kind: 'decoded', bytes: 0, entries: 0, matching: 0, withUrl: 0 }
  ])
})

test('reports transport errors without logging exception details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret') })
  const events: CanvasDiagnostic[] = []
  assert.equal(await fetchCanvas(trackUri, 'secret', (event) => events.push(event)), null)
  assert.deepEqual(events, [{ kind: 'request-error' }])
})

test('reports matching entries and media URLs in a protobuf fixture', async (t) => {
  const field = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag, content.length]), content])
  const entry = Buffer.concat([
    field(10, Buffer.from('canvas-id')),
    field(18, Buffer.from('https://example.com/canvas.mp4')),
    field(42, Buffer.from(trackUri))
  ])
  const body = field(10, entry)
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(body), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  const result = await fetchCanvas(trackUri, 'secret', (event) => events.push(event))
  assert.equal(result?.data.canvasesList[0]?.trackUri, trackUri)
  assert.deepEqual(events, [
    { kind: 'http', status: 200 },
    { kind: 'decoded', bytes: body.length, entries: 1, matching: 1, withUrl: 1 }
  ])
})
