import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appleMusicArtists,
  appleMusicMotion,
  matchAppleMusicIsrc,
  normalizeAppleMusicIsrc
} from './appleMusicMedia.ts'
import { buildTrackMedia } from './trackMedia.ts'

test('preserves individual artist identities and provider artwork', () => {
  const artists = appleMusicArtists(
    [
      {
        id: '1',
        attributes: {
          name: 'Daft Punk',
          artwork: {
            url: 'https://example.com/{w}x{h}.jpg',
            width: 640,
            height: 640
          }
        }
      },
      { id: '2', attributes: { name: 'Pharrell Williams' } }
    ],
    'Daft Punk & Pharrell Williams'
  )
  assert.deepEqual(buildTrackMedia('applemusic', { artists }).artists, [
    {
      name: 'Daft Punk',
      id: '1',
      artwork: [
        { url: 'https://example.com/640x640.jpg', width: 640, height: 640 }
      ]
    },
    { name: 'Pharrell Williams', id: '2' }
  ])
})

test('does not guess identities when relationships contain only IDs', () => {
  assert.deepEqual(appleMusicArtists([{ id: '1' }, { id: '2' }], 'A & B'), [
    { name: 'A & B' }
  ])
  assert.deepEqual(appleMusicArtists([{ id: '1' }], 'A'), [
    { name: 'A', id: '1' }
  ])
})

test('does not misattribute partially populated relationships', () => {
  assert.deepEqual(
    appleMusicArtists(
      [{ id: '1', attributes: { name: 'A' } }, { id: '2' }],
      'A & B'
    ),
    [{ name: 'A & B' }]
  )
})

test('malformed artist attributes do not throw or invent media', () => {
  const malformed = [
    {
      id: '1',
      attributes: { name: 123, artwork: { url: 42, width: 640, height: 640 } }
    }
  ] as unknown as Parameters<typeof appleMusicArtists>[0]
  assert.deepEqual(appleMusicArtists(malformed, 'Known artist'), [
    { name: 'Known artist', id: '1' }
  ])
  const malformedArtwork = [
    {
      id: '2',
      attributes: {
        name: 'Artist',
        artwork: { url: 42, width: 640, height: 640 }
      }
    }
  ] as unknown as Parameters<typeof appleMusicArtists>[0]
  assert.deepEqual(appleMusicArtists(malformedArtwork), [
    { name: 'Artist', id: '2' }
  ])
})

test('returns distinct album motion variants with explicit album scope', () => {
  const square = 'https://example.com/square.m3u8'
  const tall = 'https://example.com/tall.m3u8'
  assert.deepEqual(
    appleMusicMotion(undefined, {
      motionDetailSquare: { video: square },
      motionSquareVideo1x1: { video: square },
      motionDetailTall: { video: tall }
    }),
    {
      url: square,
      scope: 'album',
      variants: [
        { url: square, aspectRatio: '1:1' },
        { url: tall, aspectRatio: '9:16' }
      ]
    }
  )
})

test('prefers track motion and does not mix album or artist variants', () => {
  const url = 'https://example.com/track.m3u8'
  assert.deepEqual(
    appleMusicMotion(
      {
        motionDetailTall: { video: url },
        motionArtistFullscreen: { video: 'https://example.com/artist.m3u8' }
      },
      { motionDetailSquare: { video: 'https://example.com/album.m3u8' } }
    ),
    {
      url,
      scope: 'track',
      variants: [{ url, aspectRatio: '9:16' }]
    }
  )
})

test('rejects malformed or untrusted motion URLs and unrelated artist videos', () => {
  assert.equal(
    appleMusicMotion({
      motionDetailSquare: { video: 123 },
      motionDetailTall: { video: 'http://example.com/video.m3u8' },
      motionArtistSquare: { video: 'https://example.com/artist.m3u8' }
    }),
    undefined
  )
})

test('normalizes valid ISRC codes and rejects free text', () => {
  assert.equal(normalizeAppleMusicIsrc(' us-ug1-22-05736 '), 'USUG12205736')
  assert.equal(normalizeAppleMusicIsrc('Taylor Swift USUG12205736'), undefined)
  assert.equal(normalizeAppleMusicIsrc('USUG1220573'), undefined)
  assert.equal(normalizeAppleMusicIsrc(null), undefined)
})

test('retains distinct exact ISRC editions and rejects unrelated results', () => {
  const song = (id: string, isrc: string, type = 'songs') => ({
    id,
    type,
    attributes: { isrc }
  })
  const first = song('1', 'USUG12205736')
  const second = song('2', 'US-UG1-22-05736')
  assert.deepEqual(
    matchAppleMusicIsrc(
      [
        first,
        first,
        second,
        song('3', 'USUG12205737'),
        song('4', 'USUG12205736', 'music-videos'),
        song('bad', 'USUG12205736')
      ],
      'USUG12205736'
    ),
    [first, second]
  )
})

test('bounds exact matches and treats unavailable results as empty', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: String(index + 1),
    type: 'songs',
    attributes: { isrc: 'USUG12205736' }
  }))
  assert.equal(matchAppleMusicIsrc(items, 'USUG12205736').length, 25)
  assert.deepEqual(matchAppleMusicIsrc(undefined, 'USUG12205736'), [])
  assert.deepEqual(matchAppleMusicIsrc(items, 'invalid'), [])
})
