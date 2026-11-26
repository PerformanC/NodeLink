import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTrackMedia, normalizeMediaImages } from './trackMedia.ts'

test('normalizes provider identifiers and omits unknown fields', () => {
  assert.deepEqual(buildTrackMedia('deezer', {
    artists: [{ id: 123, name: ' Artist ' }, { id: 456 }],
    album: { id: 'abc', name: 'Album' }
  }), {
    provider: 'deezer',
    artists: [{ id: '123', name: 'Artist' }],
    album: { id: 'abc', name: 'Album' }
  })
})

test('does not treat motion artwork as a Spotify Canvas', () => {
  assert.deepEqual(buildTrackMedia('applemusic', {
    motionArtworkUrl: 'https://example.com/motion.m3u8'
  }), {
    provider: 'applemusic',
    artists: [],
    motionArtwork: { url: 'https://example.com/motion.m3u8' }
  })
})

test('rejects unsafe or missing media URLs and omits empty albums', () => {
  assert.deepEqual(buildTrackMedia('tidal', {
    album: { artwork: [{ url: 'file:///tmp/cover.jpg' }] },
    motionArtworkUrl: 'https://user:pass@example.com/video'
  }), { provider: 'tidal', artists: [] })
})

test('merges dimensions for identical images without inventing sizes', () => {
  assert.deepEqual(normalizeMediaImages([
    { url: 'https://example.com/a', width: 640 },
    { url: 'https://example.com/a', height: 640 },
    { url: 'https://example.com/b', width: -1 }
  ]), [
    { url: 'https://example.com/a', width: 640, height: 640 },
    { url: 'https://example.com/b' }
  ])
})

test('keeps video thumbnails and channels separate from album metadata', () => {
  assert.deepEqual(buildTrackMedia('youtube', {
    artwork: [{ url: 'https://example.com/video.jpg' }],
    channel: { id: 'channel', name: 'Uploader' }
  }), {
    provider: 'youtube',
    artists: [],
    artwork: [{ url: 'https://example.com/video.jpg' }],
    channel: { id: 'channel', name: 'Uploader' }
  })
})
