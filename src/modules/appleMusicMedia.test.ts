import assert from 'node:assert/strict'
import test from 'node:test'
import { appleMusicArtists } from './appleMusicMedia.ts'
import { buildTrackMedia } from './trackMedia.ts'

test('preserves individual artist identities and provider artwork', () => {
  const artists = appleMusicArtists([
    { id: '1', attributes: { name: 'Daft Punk', artwork: { url: 'https://example.com/{w}x{h}.jpg', width: 640, height: 640 } } },
    { id: '2', attributes: { name: 'Pharrell Williams' } }
  ], 'Daft Punk & Pharrell Williams')
  assert.deepEqual(buildTrackMedia('applemusic', { artists }).artists, [
    { name: 'Daft Punk', id: '1', artwork: [{ url: 'https://example.com/640x640.jpg', width: 640, height: 640 }] },
    { name: 'Pharrell Williams', id: '2' }
  ])
})

test('does not guess identities when relationships contain only IDs', () => {
  assert.deepEqual(appleMusicArtists([{ id: '1' }, { id: '2' }], 'A & B'), [{ name: 'A & B' }])
  assert.deepEqual(appleMusicArtists([{ id: '1' }], 'A'), [{ name: 'A', id: '1' }])
})

test('does not misattribute partially populated relationships', () => {
  assert.deepEqual(appleMusicArtists([{ id: '1', attributes: { name: 'A' } }, { id: '2' }], 'A & B'), [{ name: 'A & B' }])
})

test('malformed artist attributes do not throw or invent media', () => {
  const malformed = [
    { id: '1', attributes: { name: 123, artwork: { url: 42, width: 640, height: 640 } } }
  ] as unknown as Parameters<typeof appleMusicArtists>[0]
  assert.deepEqual(appleMusicArtists(malformed, 'Known artist'), [{ name: 'Known artist', id: '1' }])
  const malformedArtwork = [
    { id: '2', attributes: { name: 'Artist', artwork: { url: 42, width: 640, height: 640 } } }
  ] as unknown as Parameters<typeof appleMusicArtists>[0]
  assert.deepEqual(appleMusicArtists(malformedArtwork), [{ name: 'Artist', id: '2' }])
})
