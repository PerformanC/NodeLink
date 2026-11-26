import assert from 'node:assert/strict'
import test from 'node:test'
import { buildQobuzMedia, qobuzCredits } from './qobuzMedia.ts'

test('normalizes Qobuz catalog, explicit recording credits, images and advertised audio limits', () => {
  const media = buildQobuzMedia(
    {
      id: 10,
      isrc: 'USUM71900764',
      track_number: 2,
      media_number: 1,
      parental_warning: false,
      maximum_bit_depth: 24,
      maximum_sampling_rate: 44.1,
      maximum_channel_count: 2,
      hires: true,
      performer: { id: 2, name: 'Artist' },
      composer: { name: 'Writer' },
      performers: 'Artist, MainArtist - Writer, Composer, Lyricist',
      album: {
        id: 'a1',
        title: 'Album',
        upc: '00602577427657',
        release_date_original: '2024-02-29',
        image: {
          large: 'https://static.qobuz.com/large.jpg',
          thumbnail: 'https://static.qobuz.com/thumb.jpg'
        },
        label: { name: 'Label' },
        genre: { name: 'Pop' }
      }
    },
    undefined,
    {
      id: 2,
      name: 'Artist',
      picture: 'https://static.qobuz.com/artist.jpg',
      biography: { content: 'Bio' }
    }
  )
  assert.equal(media.artists[0]?.artwork?.length, 1)
  assert.equal(media.artists[0]?.biography?.text, 'Bio')
  assert.equal(media.album?.artwork?.length, 2)
  assert.equal(media.album?.label, 'Label')
  assert.equal(media.album?.releaseDate, '2024-02-29')
  assert.equal(media.identifiers?.upc, '00602577427657')
  assert.deepEqual(media.catalog?.audioSpecifications, {
    maximumBitDepth: 24,
    maximumSamplingRateHz: 44100,
    maximumChannelCount: 2,
    hiRes: true
  })
  assert.deepEqual(media.catalog?.genres, ['Pop'])
  assert.equal(media.catalog?.explicit, false)
  assert.equal(
    media.credits?.filter(
      (credit) => credit.name === 'Writer' && credit.role === 'Composer'
    ).length,
    1
  )
})

test('does not mix another album or artist, or fabricate invalid values', () => {
  const media = buildQobuzMedia(
    {
      performer: { id: 1, name: 'A' },
      album: { id: 'b' },
      maximum_sampling_rate: -1
    },
    { id: 'a', upc: '123456789012' },
    { id: 2, picture: 'https://static.qobuz.com/artist.jpg' }
  )
  assert.equal(media.identifiers, undefined)
  assert.equal(media.artists[0]?.artwork, undefined)
  assert.equal(media.catalog, undefined)
  assert.deepEqual(qobuzCredits('Unknown - Person, '), [])
})
