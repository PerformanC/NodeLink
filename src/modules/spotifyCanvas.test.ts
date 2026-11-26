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
  assert.equal(request?.redirect, 'error')
  assert.ok(request?.signal instanceof AbortSignal)
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
    { kind: 'short-response', fields: [{ number: 2, wireType: 0 }], complete: true },
    { kind: 'negative-cache', ttlSeconds: 1000 }
  ])
})

test('distinguishes a truncated field from a complete short response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(new Uint8Array([0x12, 0x05, 0x01]), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  await fetchCanvas(trackUri, 'truncated-fixture', (event) => events.push(event))
  assert.deepEqual(events.at(-1), {
    kind: 'short-response',
    fields: [{ number: 2, wireType: 2 }],
    complete: false
  })
})

test('negative cache expires and is isolated by track and credential', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const request = t.mock.method(globalThis, 'fetch', async () =>
    new Response(new Uint8Array([0x10, 0x02]), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  const collect = (event: CanvasDiagnostic) => events.push(event)
  await fetchCanvas(trackUri, 'cache-fixture', collect)
  assert.equal(request.mock.callCount(), 1)
  assert.deepEqual(events.at(-1), { kind: 'negative-cache', ttlSeconds: 2 })
  await fetchCanvas(trackUri, 'cache-fixture', collect)
  assert.equal(request.mock.callCount(), 1)
  assert.deepEqual(events.at(-1), { kind: 'negative-cache-hit', remainingSeconds: 2 })
  await fetchCanvas(trackUri, 'other-credential', collect)
  await fetchCanvas('spotify:track:def', 'cache-fixture', collect)
  assert.equal(request.mock.callCount(), 3)
  now += 2000
  await fetchCanvas(trackUri, 'cache-fixture', collect)
  assert.equal(request.mock.callCount(), 4)
})

test('caps a long provider TTL at one hour', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(new Uint8Array([0x10, 0x90, 0x4e]), { status: 200 }))
  const events: CanvasDiagnostic[] = []
  await fetchCanvas(trackUri, 'long-ttl-fixture', (event) => events.push(event))
  assert.deepEqual(events.at(-1), { kind: 'negative-cache', ttlSeconds: 3600 })
})

test('never caches errors or malformed, zero or missing TTL responses', async (t) => {
  const fixtures = [
    new Uint8Array(),
    new Uint8Array([0x10, 0]),
    new Uint8Array([0x10, 0x80]),
    new Uint8Array([0x10, 2, 0x12, 5]),
    new Uint8Array([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1])
  ]
  let response = new Uint8Array()
  let status = 200
  const request = t.mock.method(globalThis, 'fetch', async () =>
    new Response(response, { status }))
  for (const fixture of fixtures) {
    response = fixture
    await fetchCanvas(trackUri, 'invalid-ttl-fixture')
    await fetchCanvas(trackUri, 'invalid-ttl-fixture')
  }
  status = 403
  response = new Uint8Array([0x10, 2])
  await fetchCanvas(trackUri, 'invalid-ttl-fixture')
  await fetchCanvas(trackUri, 'invalid-ttl-fixture')
  assert.equal(request.mock.callCount(), fixtures.length * 2 + 2)
})
