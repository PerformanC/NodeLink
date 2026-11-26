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

test('sends the existing binary request with a protobuf content type', async (t) => {
  let request: RequestInit | undefined
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    request = init
    return new Response(new Uint8Array(), { status: 200 })
  })
  await fetchCanvas(trackUri, 'secret')
  const headers = new Headers(request?.headers)
  assert.equal(headers.get('content-type'), 'application/protobuf')
  assert.equal(headers.get('accept'), 'application/protobuf')
  assert.equal(request?.method, 'POST')
  assert.deepEqual(request?.body, Buffer.concat([
    Buffer.from([10, 19, 10, 17]),
    Buffer.from(trackUri)
  ]))
})

test('reports only field tags for a short response without Canvas entries', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(new Uint8Array([0x10, 0xe8, 0x07]), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  await fetchCanvas(trackUri, 'secret', (event) => events.push(event))
  assert.deepEqual(events, [
    { kind: 'http', status: 200 },
    { kind: 'decoded', bytes: 3, entries: 0, matching: 0, withUrl: 0 },
    { kind: 'short-response', fields: [{ number: 2, wireType: 0 }], complete: true }
  ])
})

test('distinguishes a truncated field from a complete short response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(new Uint8Array([0x12, 0x05, 0x01]), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  await fetchCanvas(trackUri, 'secret', (event) => events.push(event))
  assert.deepEqual(events.at(-1), {
    kind: 'short-response',
    fields: [{ number: 2, wireType: 2 }],
    complete: false
  })
})
