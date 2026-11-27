import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MediaLookupClient } from './mediaLookupClient.ts'

test('HTTP-date Retry-After blocks a new request for the full interval', async () => {
  let now = Date.UTC(2026, 0, 1)
  const original = Date.now
  Date.now = () => now
  let calls = 0
  try {
    const client = new MediaLookupClient(async () => {
      calls++
      return new Response(null, { status: 503, headers: { 'retry-after': new Date(now + 120_000).toUTCString() } })
    })
    const request = (key: string) => client.lookup(key, 'https://musicbrainz.org/', {}, x => x)
    assert.equal((await request('first')).status, 502)
    now += 61_000
    assert.equal((await request('second')).status, 429)
    assert.equal(calls, 1)
    now += 60_000
    assert.equal((await request('third')).status, 502)
    assert.equal(calls, 2)
  } finally {
    Date.now = original
  }
})

test('oversized response is rejected and never normalized', async () => {
  let normalized = false
  const client = new MediaLookupClient(async () =>
    new Response(new Uint8Array(1024 * 1024 + 1))
  )
  const result = await client.lookup('large', 'https://musicbrainz.org/', {}, (value) => {
    normalized = true
    return value
  })
  assert.equal(result.status, 502)
  assert.equal(result.reason, 'response-too-large')
  assert.equal(normalized, false)
})

test('redirects are disabled and successful cache hits avoid network requests', async () => {
  let calls = 0
  const client = new MediaLookupClient(async (_url, init) => {
    calls++
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    return new Response('{"id":"fixture"}')
  })
  const request = () => client.lookup('id', 'https://musicbrainz.org/', {}, (value) => value)
  assert.equal((await request()).status, 200)
  assert.deepEqual((await request()).data, { id: 'fixture' })
  assert.equal(calls, 1)
})
