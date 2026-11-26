import assert from 'node:assert/strict'
import test from 'node:test'
import { amazonTrackIdentity, buildAmazonMedia } from './amazonMusicMedia.ts'

test('preserves real artist and album identities and track ISRC', () => {
  assert.deepEqual(
    buildAmazonMedia(
      { isrc: 'USUG11904206' },
      {
        byArtist: [
          { name: 'A', url: 'https://music.amazon.com/artists/B012345678' },
          { name: 'B', url: 'https://example.com/artists/B012345679' }
        ],
        inAlbum: {
          name: 'Album',
          url: 'https://music.amazon.com/albums/B012345670'
        },
        image: 'https://example.com/cover.jpg'
      }
    ),
    {
      provider: 'amazonmusic',
      artists: [{ name: 'A', id: 'B012345678' }, { name: 'B' }],
      identifiers: { isrc: 'USUG11904206' },
      artwork: [{ url: 'https://example.com/cover.jpg' }],
      album: { name: 'Album', id: 'B012345670' }
    }
  )
})

test('does not invent album or recording identifiers from search artwork', () => {
  assert.deepEqual(
    buildAmazonMedia({
      author: 'Unknown Artist',
      artworkUrl: 'https://example.com/cover.jpg'
    }),
    {
      provider: 'amazonmusic',
      artists: [],
      artwork: [{ url: 'https://example.com/cover.jpg' }]
    }
  )
})

test('does not attribute playlist cover or curator to the track', () => {
  assert.deepEqual(
    buildAmazonMedia(
      { author: 'Curator', artworkUrl: 'https://example.com/playlist.jpg' },
      {},
      {
        '@type': 'Playlist',
        name: 'Playlist'
      }
    ),
    { provider: 'amazonmusic', artists: [] }
  )
})

test('does not use playlist cover when a track has an album relationship', () => {
  assert.deepEqual(
    buildAmazonMedia(
      { artworkUrl: 'https://example.com/playlist.jpg' },
      {
        inAlbum: {
          name: 'Actual album',
          image: 'https://example.com/album.jpg'
        }
      },
      { '@type': 'Playlist' }
    ),
    {
      provider: 'amazonmusic',
      artists: [],
      album: {
        name: 'Actual album',
        artwork: [{ url: 'https://example.com/album.jpg' }]
      }
    }
  )
})

test('prefers the canonical recording identity returned by Amazon', () => {
  const uri = 'https://music.amazon.com/tracks/B07N7PRLYZ'
  assert.deepEqual(amazonTrackIdentity({ url: uri }, 'B07N7VNZLY'), {
    id: 'B07N7PRLYZ',
    uri
  })
})

test('accepts canonical JSON-LD id and rejects untrusted or non-track URLs', () => {
  const uri = 'https://music.amazon.com/tracks/B07N7PRLYZ'
  assert.deepEqual(
    amazonTrackIdentity({
      url: 'https://music.amazon.com.evil.example/tracks/B07N7VNZLY',
      '@id': uri
    }),
    { id: 'B07N7PRLYZ', uri }
  )
  assert.deepEqual(
    amazonTrackIdentity(
      {
        url: 'https://music.amazon.com/albums/B07N7PBZGF'
      },
      'B07N7VNZLY'
    ),
    {
      id: 'B07N7VNZLY',
      uri: 'https://music.amazon.com/tracks/B07N7VNZLY'
    }
  )
  assert.equal(
    amazonTrackIdentity({
      url: 'https://music.amazon.com:8443/tracks/B07N7PRLYZ'
    }),
    undefined
  )
  assert.equal(amazonTrackIdentity({}, 'invalid'), undefined)
})
