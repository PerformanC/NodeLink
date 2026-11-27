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
