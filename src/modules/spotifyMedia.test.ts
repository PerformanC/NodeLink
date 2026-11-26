import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSpotifyMedia, spotifyCanvasMedia } from './spotifyMedia.ts'

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
