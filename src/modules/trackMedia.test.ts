import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTrackMedia, normalizeMediaImages } from './trackMedia.ts'

test('normalizes provider identifiers and omits unknown fields', () => {
  assert.deepEqual(
    buildTrackMedia('deezer', {
      artists: [{ id: 123, name: ' Artist ' }, { id: 456 }],
      album: { id: 'abc', name: 'Album' }
    }),
    {
      provider: 'deezer',
      artists: [{ id: '123', name: 'Artist' }],
      album: { id: 'abc', name: 'Album' }
    }
  )
})

test('does not treat motion artwork as a Spotify Canvas', () => {
  assert.deepEqual(
    buildTrackMedia('applemusic', {
      motionArtworkUrl: 'https://example.com/motion.m3u8'
    }),
    {
      provider: 'applemusic',
      artists: [],
      motionArtwork: { url: 'https://example.com/motion.m3u8' }
    }
  )
})

test('rejects unsafe or missing media URLs and omits empty albums', () => {
  assert.deepEqual(
    buildTrackMedia('tidal', {
      album: { artwork: [{ url: 'file:///tmp/cover.jpg' }] },
      motionArtworkUrl: 'https://user:pass@example.com/video'
    }),
    { provider: 'tidal', artists: [] }
  )
})

test('merges dimensions for identical images without inventing sizes', () => {
  assert.deepEqual(
    normalizeMediaImages([
      { url: 'https://example.com/a', width: 640 },
      { url: 'https://example.com/a', height: 640 },
      { url: 'https://example.com/b', width: -1 }
    ]),
    [
      { url: 'https://example.com/a', width: 640, height: 640 },
      { url: 'https://example.com/b' }
    ]
  )
})

test('keeps video thumbnails and channels separate from album metadata', () => {
  assert.deepEqual(
    buildTrackMedia('youtube', {
      artwork: [{ url: 'https://example.com/video.jpg' }],
      channel: { id: 'channel', name: 'Uploader' }
    }),
    {
      provider: 'youtube',
      artists: [],
      artwork: [{ url: 'https://example.com/video.jpg' }],
      channel: { id: 'channel', name: 'Uploader' }
    }
  )
})

test('normalizes identifiers, palette and explicit composer credits without guessing names', () => {
  assert.deepEqual(
    buildTrackMedia('applemusic', {
      identifiers: {
        isrc: 'us-ug1-19-04206',
        upc: '00602445545803',
        ean: 'bad'
      },
      colors: { dark: '#701010', light: '#e82121', raw: 'invalid' },
      credits: [
        { name: ' A & B ', role: 'composer' },
        { name: 'A & B', role: 'composer' }
      ]
    }),
    {
      provider: 'applemusic',
      artists: [],
      identifiers: { isrc: 'USUG11904206', upc: '00602445545803' },
      colors: { dark: '#701010', light: '#E82121' },
      credits: [{ name: 'A & B', role: 'composer' }]
    }
  )
})

test('keeps Holo channel banners and avatars separate from track artwork', () => {
  assert.deepEqual(
    buildTrackMedia('youtube', {
      artwork: [{ url: 'https://example.com/video.jpg' }],
      channel: {
        name: 'Channel',
        id: 'abc',
        artwork: [{ url: 'https://example.com/icon.jpg' }],
        banners: [
          { url: 'https://example.com/banner.jpg' },
          { url: 'http://example.com/no.jpg' }
        ]
      }
    }),
    {
      provider: 'youtube',
      artists: [],
      artwork: [{ url: 'https://example.com/video.jpg' }],
      channel: {
        name: 'Channel',
        id: 'abc',
        artwork: [{ url: 'https://example.com/icon.jpg' }],
        banners: [{ url: 'https://example.com/banner.jpg' }]
      }
    }
  )
})
