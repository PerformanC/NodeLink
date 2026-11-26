import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSpotifyMedia, spotifyCanvasMedia, selectSpotifyCanvas, spotifyCanvasSessionState } from './spotifyMedia.ts'

test('normalizes official artist and album metadata with image dimensions', () => {
  assert.deepEqual(buildSpotifyMedia({ artists: [{ id: 'a', name: 'Artist' }], album: { id: 'b', name: 'Album', images: [{ url: 'https://example.com/cover', width: 640, height: 640 }] } }), {
    provider: 'spotify', artists: [{ id: 'a', name: 'Artist' }], album: { id: 'b', name: 'Album', artwork: [{ url: 'https://example.com/cover', width: 640, height: 640 }] }
  })
})

test('supports internal primary and secondary artists', () => {
  assert.deepEqual(buildSpotifyMedia({ firstArtist: { items: [{ uri: 'spotify:artist:a', profile: { name: 'A' } }] }, otherArtists: { items: [{ name: 'B' }] } }).artists, [{ name: 'A', id: 'a' }, { name: 'B' }])
})

test('deduplicates artwork and rejects unsafe URLs and invalid dimensions', () => {
  assert.deepEqual(buildSpotifyMedia({ album: { images: [{ url: 'https://example.com/a', width: 100 }, { url: 'https://example.com/a', height: 100 }, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/a' }, { url: 'https://example.com/b', width: -1 }] } }).album?.artwork, [{ url: 'https://example.com/a', width: 100, height: 100 }, { url: 'https://example.com/b' }])
})

test('omits unavailable metadata and accepts fallback artwork', () => {
  assert.deepEqual(buildSpotifyMedia({}), { provider: 'spotify', artists: [] })
  assert.deepEqual(buildSpotifyMedia({}, 'https://example.com/fallback').album, { artwork: [{ url: 'https://example.com/fallback' }] })
})

test('normalizes Canvas only for the matching track and a safe URL', () => {
  const entry = { id: 'c', canvasUrl: 'https://example.com/c.mp4', trackUri: 'spotify:track:a' }
  assert.deepEqual(spotifyCanvasMedia(entry, 'spotify:track:a'), { id: 'c', url: entry.canvasUrl })
  assert.equal(spotifyCanvasMedia(entry, 'spotify:track:b'), undefined)
  assert.equal(spotifyCanvasMedia({ canvasUrl: 'file:///tmp/c.mp4' }, 'spotify:track:a'), undefined)
})

test('selects a valid matching Canvas even after unrelated or unusable entries', () => {
  const target = 'spotify:track:target'
  const valid = { id: 'correct', trackUri: target, canvasUrl: 'https://example.com/loop.mp4' }
  const unrelated = { id: 'wrong', trackUri: 'spotify:track:other', canvasUrl: valid.canvasUrl }
  const unsafe = { id: 'unsafe', trackUri: target, canvasUrl: 'file:///tmp/loop.mp4' }
  assert.deepEqual(selectSpotifyCanvas([unrelated, unsafe, valid], target), {
    entry: valid, canvas: { id: valid.id, url: valid.canvasUrl }
  })
  assert.equal(selectSpotifyCanvas([unrelated, unsafe], target), undefined)
  assert.equal(selectSpotifyCanvas(undefined, target), undefined)
})

test('classifies Canvas session availability without exposing credentials', () => {
  assert.equal(spotifyCanvasSessionState(null, 2000, 1000), 'missing')
  assert.equal(spotifyCanvasSessionState('  ', 2000, 1000), 'missing')
  assert.equal(spotifyCanvasSessionState('fixture', 1000, 1000), 'expired')
  assert.equal(spotifyCanvasSessionState('fixture', 999, 1000), 'expired')
  assert.equal(spotifyCanvasSessionState('fixture', null, 1000), 'unknown-expiry')
  assert.equal(spotifyCanvasSessionState('fixture', Number.NaN, 1000), 'unknown-expiry')
  assert.equal(spotifyCanvasSessionState('fixture', 1001, 1000), 'ready')
})

test('preserves optional Canvas playback metadata in the public media contract', () => {
  const entry = { id: 'abc', trackUri: 'spotify:track:a', canvasUrl: 'https://canvaz.scdn.co/example.mp4', canvasUri: 'spotify:canvas:abc', fileId: '0123456789abcdef0123456789abcdef', type: 'VIDEO_LOOPING_RANDOM' }
  assert.deepEqual(selectSpotifyCanvas([entry], entry.trackUri)?.canvas, { url: entry.canvasUrl, id: entry.id, uri: entry.canvasUri, fileId: entry.fileId, type: entry.type })
  assert.deepEqual(spotifyCanvasMedia({ ...entry, canvasUri: 'invalid', fileId: 'bad', type: 'bad type' }, entry.trackUri), { url: entry.canvasUrl, id: entry.id })
})
