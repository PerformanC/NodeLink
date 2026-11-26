import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTidalCatalog, tidalPreview } from './tidalCatalog.ts'
import { buildTrackMedia } from './trackMedia.ts'

test('matches linked genres and biographies by track, type and artist identity', () => {
  const media = buildTrackMedia('tidal', { artists: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
  const document = {
    data: { id: '10', type: 'tracks', relationships: {
      genres: { data: [{ id: '5', type: 'genres' }] },
      artists: { data: [{ id: '1', type: 'artists' }] }
    }},
    included: [
      { id: '5', type: 'genres', attributes: { genreName: 'pop' } },
      { id: '6', type: 'genres', attributes: { genreName: 'unrelated' } },
      { id: '1', type: 'artists', relationships: { biography: { data: { id: '7', type: 'artistBiographies' } } } },
      { id: '7', type: 'artistBiographies', attributes: { text: 'Biography', source: 'TIDAL' } }
    ]
  }
  applyTidalCatalog(media, '11', document)
  assert.equal(media.catalog, undefined)
  applyTidalCatalog(media, '10', document)
  assert.deepEqual(media.catalog?.genres, ['pop'])
  assert.deepEqual(media.artists[0]?.biography, { text: 'Biography', source: 'TIDAL' })
  assert.equal(media.artists[1]?.biography, undefined)
})

test('accepts only explicit HTTPS Tidal preview URLs and ignores API errors', () => {
  const url = 'https://audio.tidal.com/preview.mp3'
  assert.equal(tidalPreview({ data: { trackPreviewUrl: url } }), url)
  assert.equal(tidalPreview({ data: { trackPreviewUrl: 'https://tidal.com.example.org/preview.mp3' } }), undefined)
  assert.equal(tidalPreview({ data: { trackPreviewUrl: url }, errors: [{}] }), undefined)
  assert.equal(tidalPreview({ data: { url } }), undefined)
})
