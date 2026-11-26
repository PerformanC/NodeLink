import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeezerMedia } from './deezerMedia.ts'

test('retains both artists, roles and CDN dimensions from direct track metadata', () => {
  const image = 'https://cdn-images.dzcdn.net/images/artist/hash/1000x1000-000000-80-0-0.jpg'
  const small = 'https://cdn-images.dzcdn.net/images/artist/hash/56x56-000000-80-0-0.jpg'
  const media = buildDeezerMedia({
    artist: { id: 9635624, name: 'Billie Eilish', picture_xl: image },
    contributors: [
      { id: 9635624, name: 'Billie Eilish', role: 'Main', picture_xl: image, picture_small: small },
      { id: 288166, name: 'Justin Bieber', role: 'Main' }
    ],
    album: { id: 103327692, title: 'bad guy (with Justin Bieber)' }
  }, 'USUM71912813')
  assert.deepEqual(media.artists, [
    { id: '9635624', name: 'Billie Eilish', artwork: [
      { url: image, width: 1000, height: 1000 },
      { url: small, width: 56, height: 56 }
    ] },
    { id: '288166', name: 'Justin Bieber' }
  ])
  assert.deepEqual(media.credits, [
    { name: 'Billie Eilish', role: 'Main' },
    { name: 'Justin Bieber', role: 'Main' }
  ])
  assert.equal(media.identifiers?.isrc, 'USUM71912813')
})

test('preserves basic search results and does not guess dimensions or roles', () => {
  const url = 'https://example.com/images/artist/hash/1000x1000-0.jpg'
  const cover = 'https://cdn-images.dzcdn.net/images/cover/hash/250x250-000000-80-0-0.jpg'
  const media = buildDeezerMedia({
    artist: { id: 1, name: 'A', picture_xl: url },
    album: { cover_medium: cover }
  })
  assert.deepEqual(media.artists, [{ id: '1', name: 'A', artwork: [{ url }] }])
  assert.deepEqual(media.album?.artwork, [{ url: cover, width: 250, height: 250 }])
  assert.equal(media.credits, undefined)
})
