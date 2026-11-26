import assert from 'node:assert/strict'
import test from 'node:test'
import { deserialize, serialize } from 'node:v8'
import { buildSpotifyMedia, spotifyCanvasMedia } from './spotifyMedia.ts'
import { buildTrackMedia } from './trackMedia.ts'

test('metadata survives worker JSON and V8 round trips for all supported source labels', () => {
  for (const source of [
    'spotify',
    'applemusic',
    'deezer',
    'tidal',
    'qobuz',
    'youtube',
    'ytmusic'
  ]) {
    const media =
      source === 'spotify'
        ? buildSpotifyMedia({ artists: [{ name: 'Artist', id: '123' }] })
        : buildTrackMedia(source, {
            artists: [{ name: 'Artist', id: '123' }],
            album: {
              name: 'Album',
              artwork: [{ url: 'https://example.com/a.jpg' }]
            }
          })
    const payload = {
      loadType: 'track',
      data: {
        encoded: 'fixture',
        info: { sourceName: source },
        pluginInfo: { legacyField: 'unchanged', media }
      }
    }
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)
    assert.deepEqual(deserialize(serialize(payload)), payload)
  }
})
test('missing Canvas track URI does not associate unverified media with a track', () => {
  assert.equal(
    spotifyCanvasMedia(
      { canvasUrl: 'https://example.com/a.mp4' },
      'spotify:track:abc'
    ),
    undefined
  )
})
test('malformed nullable artwork arrays do not throw', () => {
  assert.doesNotThrow(() =>
    buildTrackMedia('deezer', {
      album: { artwork: null }
    } as unknown as Parameters<typeof buildTrackMedia>[1])
  )
})
test('malformed non-string artist name does not throw', () => {
  assert.doesNotThrow(() =>
    buildSpotifyMedia({ artists: [{ name: 123 }] } as unknown as Parameters<
      typeof buildSpotifyMedia
    >[0])
  )
})
test('Spotify artist whitespace is normalized consistently with other providers', () => {
  assert.equal(
    buildSpotifyMedia({ artists: [{ name: '  Artist  ' }] }).artists[0]?.name,
    'Artist'
  )
})
test('all collaborators and image variants survive the normalized payload', () => {
  const media = buildTrackMedia('deezer', {
    artists: [
      {
        name: 'A',
        id: 1,
        artwork: [
          { url: 'https://example.com/1' },
          { url: 'https://example.com/2' }
        ]
      },
      { name: 'B', id: 2 }
    ],
    album: { id: 3, artwork: [{ url: 'https://example.com/3' }] }
  })
  assert.equal(media.artists.length, 2)
  assert.equal(media.artists[0]?.artwork?.length, 2)
  assert.equal(media.album?.id, '3')
})
