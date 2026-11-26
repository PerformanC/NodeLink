import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTidalMedia } from './tidalMedia.ts'

const picture = '0491c8eb-c16f-409c-915d-36a79d9e6384'
const cover = '8f2d544e-2452-46de-ba70-25498434e2ef'
const video = '013025b8-be1c-4fa3-b321-5cef05af20d2'

test('normalizes v1 artist photos, roles, covers, color and animated artwork', () => {
  const media = buildTidalMedia({
    isrc: 'USUM71900764',
    artists: [
      { id: 1, name: 'A', type: 'MAIN', picture },
      { id: 2, name: 'B', type: 'FEATURED' }
    ],
    artist: { id: 1, name: 'A' },
    album: {
      id: 3,
      title: 'Album',
      cover,
      videoCover: video,
      vibrantColor: '#cb8784',
      upc: '00602577427657'
    }
  })
  assert.equal(media.artists.length, 2)
  assert.equal(media.artists[0]?.artwork?.length, 4)
  assert.equal(media.artists[0]?.artwork?.[0]?.width, 750)
  assert.deepEqual(media.credits, [
    { name: 'A', role: 'MAIN' },
    { name: 'B', role: 'FEATURED' }
  ])
  assert.equal(media.album?.artwork?.length, 5)
  assert.equal(media.album?.artwork?.[0]?.width, 1280)
  assert.equal(media.colors?.raw, '#CB8784')
  assert.equal(media.identifiers?.upc, '00602577427657')
  assert.equal(media.motionArtwork?.scope, 'album')
  assert.equal(
    media.motionArtwork?.url,
    'https://resources.tidal.com/videos/013025b8/be1c/4fa3/b321/5cef05af20d2/1280x1280.mp4'
  )
  assert.equal(media.motionArtwork?.variants?.length, 5)
  assert.equal(media.motionArtwork?.variants?.[0]?.width, 1280)
})

test('reuses matching album metadata without leaking another edition', () => {
  const parent = {
    id: 3,
    title: 'Album',
    cover,
    upc: '00602577427657',
    videoCover: video
  }
  const match = buildTidalMedia(
    { album: { id: '3', cover, videoCover: null } },
    parent
  )
  assert.equal(match.identifiers?.upc, '00602577427657')
  assert.ok(match.motionArtwork)
  const mismatch = buildTidalMedia({ album: { id: 4, title: 'Other' } }, parent)
  assert.equal(mismatch.album?.id, '4')
  assert.equal(mismatch.identifiers, undefined)
  assert.equal(mismatch.motionArtwork, undefined)
})

test('omits malformed resources, unknown roles and missing fields', () => {
  const media = buildTidalMedia({
    artist: { id: 1, name: 'A', picture: '../bad', type: 'CONTRIBUTOR' },
    album: {
      id: 2,
      cover: 'https://example.com',
      videoCover: 'bad',
      vibrantColor: 'unknown'
    }
  })
  assert.deepEqual(media.artists, [{ id: '1', name: 'A', url: 'https://tidal.com/browse/artist/1' }])
  assert.deepEqual(media.album, { id: '2', url: 'https://tidal.com/browse/album/2' })
  assert.equal(media.credits, undefined)
  assert.equal(media.colors, undefined)
  assert.equal(media.motionArtwork, undefined)
  assert.deepEqual(buildTidalMedia({}), { provider: 'tidal', artists: [] })
})

test('preserves catalog metadata and grouped track credits without conflating album credits', () => {
  const media = buildTidalMedia({
    id: 10, trackNumber: 2, volumeNumber: 1, explicit: false, popularity: 0,
    copyright: 'Recording rights', version: 'Live', audioQuality: 'LOSSLESS',
    audioModes: ['STEREO', 'STEREO'], mediaMetadata: { tags: ['LOSSLESS'] },
    credits: [{ type: 'Composer', contributors: [{ name: 'Writer' }] }],
    album: { id: 3 }
  }, {
    id: 3, releaseDate: '2024-02-29', copyright: 'Album rights', type: 'ALBUM',
    numberOfTracks: 10, numberOfVolumes: 1, label: 'Label',
    credits: [{ type: 'Producer', contributors: [{ name: 'Album producer' }] }]
  }, [
    { type: 'Composer', contributors: [{ name: 'Writer' }] },
    { type: 'Producer', contributors: [{ name: 'Track producer' }] }
  ])
  assert.equal(media.catalog?.url, 'https://tidal.com/browse/track/10')
  assert.equal(media.catalog?.trackNumber, 2)
  assert.equal(media.catalog?.discNumber, 1)
  assert.equal(media.catalog?.explicit, false)
  assert.equal(media.catalog?.popularity, 0)
  assert.deepEqual(media.catalog?.audioModes, ['STEREO'])
  assert.deepEqual(media.catalog?.mediaTags, ['LOSSLESS'])
  assert.equal(media.album?.releaseDate, '2024-02-29')
  assert.equal(media.album?.label, 'Label')
  assert.equal(media.album?.trackCount, 10)
  assert.equal(media.album?.discCount, 1)
  assert.deepEqual(media.credits, [
    { name: 'Writer', role: 'Composer' },
    { name: 'Track producer', role: 'Producer' }
  ])
})

test('rejects invalid catalog fields and malformed credits', () => {
  const media = buildTidalMedia({
    trackNumber: -1, volumeNumber: 1.5, explicit: 'false', popularity: 200,
    audioModes: [null, 1, ' '], album: { releaseDate: '2025-02-30' },
    credits: [null, { type: 'Composer', contributors: [{ name: '' }] }]
  })
  assert.equal(media.catalog, undefined)
  assert.equal(media.album, undefined)
  assert.equal(media.credits, undefined)
})
