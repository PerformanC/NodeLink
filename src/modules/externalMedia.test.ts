import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fanartArtist,
  musicBrainzRecordings,
  musicBrainzWork
} from './externalMedia.ts'
import { MediaLookupClient } from './mediaLookupClient.ts'
import { resolveMediaCredential } from './mediaProviderConfig.ts'

const id = '12345678-1234-1234-1234-123456789abc'
const artist = '12345678-1234-1234-1234-123456789abd'
const isrc = 'USUG12205736'

test('retains verified recording candidates and credits', () => {
  const recording = {
    id,
    title: 'Song',
    isrcs: [isrc],
    'artist-credit': [{ artist: { id: artist, name: 'Artist' } }],
    relations: [{ type: 'producer', artist: { id: artist, name: 'Artist' } }]
  }
  const result = musicBrainzRecordings(
    {
      isrc,
      recordings: [
        recording,
        recording,
        { ...recording, id: artist, isrcs: ['USUG12205737'] }
      ]
    },
    isrc
  )
  assert.equal(result?.recordings.length, 1)
  assert.deepEqual(result?.recordings[0]?.credits, [
    { name: 'Artist', role: 'producer', mbid: artist }
  ])
  assert.equal(
    musicBrainzRecordings(
      { isrc: 'USUG12205737', recordings: [recording] },
      isrc
    ),
    null
  )
  assert.equal(musicBrainzWork({ id: artist }, id), null)
})

test('preserves artwork types and rejects foreign asset hosts', () => {
  const result = fanartArtist(
    {
      mbid_id: id,
      musicbanner: [
        {
          url: 'http://assets.fanart.tv/banner.jpg',
          width: '1000',
          height: '185'
        }
      ],
      artistbackground: [{ url: 'https://example.com/fake.jpg' }]
    },
    id
  )
  assert.deepEqual(result?.banners, [
    { url: 'https://assets.fanart.tv/banner.jpg', width: 1000, height: 185 }
  ])
  assert.deepEqual(result?.backgrounds, [])
  assert.equal(fanartArtist({ mbid_id: artist }, id), null)
})

test('caches successful lookups and bounds request rate', async () => {
  let calls = 0
  const client = new MediaLookupClient(async () => {
    calls++
    return new Response(JSON.stringify({ ok: true }))
  })
  const normalize = (value: unknown) => value
  assert.equal(
    (await client.lookup('one', 'https://example.com', {}, normalize)).status,
    200
  )
  assert.equal(
    (await client.lookup('one', 'https://example.com', {}, normalize)).status,
    200
  )
  assert.equal(
    (await client.lookup('two', 'https://example.com', {}, normalize)).status,
    429
  )
  assert.equal(calls, 1)
})

test('does not cache upstream failures', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  let calls = 0
  const client = new MediaLookupClient(async () => {
    calls++
    return new Response('', { status: 500 })
  })
  assert.equal(
    (await client.lookup('one', 'https://example.com', {}, (value) => value))
      .status,
    502
  )
  now += 1200
  assert.equal(
    (await client.lookup('one', 'https://example.com', {}, (value) => value))
      .status,
    502
  )
  assert.equal(calls, 2)
})

test('diagnoses upstream HTTP errors without exposing the response body', async () => {
  const client = new MediaLookupClient(
    async () => new Response('private diagnostic', { status: 401 })
  )
  assert.deepEqual(
    await client.lookup('one', 'https://example.com', {}, (value) => value),
    {
      status: 502,
      data: null,
      reason: 'upstream-http',
      upstreamStatus: 401
    }
  )
})

test('distinguishes unexpected provider payloads from invalid JSON', async () => {
  const invalid = new MediaLookupClient(async () => new Response('not JSON'))
  const unexpected = new MediaLookupClient(async () => new Response('{}'))
  assert.equal(
    (await invalid.lookup('one', 'https://example.com', {}, (value) => value))
      .reason,
    'invalid-json'
  )
  assert.equal(
    (await unexpected.lookup('one', 'https://example.com', {}, () => null))
      .reason,
    'unexpected-provider-payload'
  )
})

test('accepts the official Fanart v3.2 artist identity and 4K backgrounds', () => {
  const result = fanartArtist(
    {
      name: 'Example artist',
      mbid_id: id,
      image_count: 2,
      artist4kbackground: [
        {
          url: 'https://assets.fanart.tv/4k.jpg',
          width: '3840',
          height: '2160'
        }
      ],
      artistbackground: [
        {
          url: 'https://assets.fanart.tv/hd.jpg',
          width: '1920',
          height: '1080'
        }
      ]
    },
    id
  )
  assert.equal(result?.mbid, id)
  assert.deepEqual(result?.backgrounds, [
    { url: 'https://assets.fanart.tv/4k.jpg', width: 3840, height: 2160 },
    { url: 'https://assets.fanart.tv/hd.jpg', width: 1920, height: 1080 }
  ])
  assert.equal(fanartArtist({ mbid: id }, id), null)
  assert.equal(fanartArtist({ mbid_id: artist, mbid: id }, id), null)
})

test('omits placeholder dimensions and deduplicates legacy and HD logos', () => {
  const url = 'https://assets.fanart.tv/logo.png'
  const result = fanartArtist(
    {
      mbid_id: id,
      hdmusiclogo: [{ url, width: '800', height: '310' }],
      musiclogo: [
        { url, width: '1', height: '1' },
        {
          url: 'https://assets.fanart.tv/legacy.png',
          width: true,
          height: '1'
        },
        { url: 'https://assets.fanart.tv:8443/foreign.png' }
      ]
    },
    id
  )
  assert.deepEqual(result?.logos, [
    { url, width: 800, height: 310 },
    { url: 'https://assets.fanart.tv/legacy.png' }
  ])
})

test('preserves environment compatibility and honors explicit provider disable', () => {
  assert.equal(resolveMediaCredential(undefined, ' env ', 'config'), 'env')
  assert.equal(resolveMediaCredential(true, '', ' config '), 'config')
  assert.equal(resolveMediaCredential(false, 'env', 'config'), undefined)
  assert.equal(resolveMediaCredential(true, 'bad\nheader', ''), undefined)
  assert.equal(
    resolveMediaCredential(undefined, undefined, undefined),
    undefined
  )
})
