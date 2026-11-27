import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  PlaylistData,
  SourceResult,
  TrackData
} from '../typings/sources/source.types.ts'
import {
  buildPlaylistInfo,
  isGenericDescription,
  extractIdentifierFromUrl,
  inferSourceNameFromUrl,
  normalizePlaylistData,
  normalizePlaylistResult,
  parseIsoDate
} from './playlistNormalizer.ts'

function createMockTrack(overrides: Partial<TrackData['info']> = {}): TrackData {
  return {
    encoded: 'mock-encoded',
    info: {
      identifier: 'track-1',
      isSeekable: true,
      author: 'Track Artist',
      length: 180000,
      isStream: false,
      position: 0,
      title: 'Track Title',
      uri: 'https://example.com/track/1',
      artworkUrl: 'https://example.com/track1.jpg',
      isrc: null,
      sourceName: 'youtube',
      ...overrides
    },
    pluginInfo: {}
  }
}

test('parseIsoDate parses strings, numbers, and handles invalid dates', () => {
  assert.equal(parseIsoDate('2023-05-10T12:00:00.000Z'), '2023-05-10T12:00:00.000Z')
  assert.equal(parseIsoDate('2023-05-10'), '2023-05-10T00:00:00.000Z')
  assert.equal(parseIsoDate(1683720000), '2023-05-10T12:00:00.000Z') // seconds
  assert.equal(parseIsoDate(1683720000000), '2023-05-10T12:00:00.000Z') // milliseconds
  assert.equal(parseIsoDate('1683720000'), '2023-05-10T12:00:00.000Z')
  assert.equal(parseIsoDate('invalid-date'), null)
  assert.equal(parseIsoDate(''), null)
  assert.equal(parseIsoDate(null), null)
  assert.equal(parseIsoDate(undefined), null)
})

test('extractIdentifierFromUrl extracts IDs from various music services', () => {
  assert.equal(
    extractIdentifierFromUrl('https://www.youtube.com/playlist?list=PL1234567890'),
    'PL1234567890'
  )
  assert.equal(
    extractIdentifierFromUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'),
    '37i9dQZF1DXcBWIGoYBM5M'
  )
  assert.equal(
    extractIdentifierFromUrl('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy'),
    '4aawyAB9vmqN3uQ7FjRGTy'
  )
  assert.equal(
    extractIdentifierFromUrl('https://music.apple.com/us/album/thriller/269572838'),
    '269572838'
  )
  assert.equal(
    extractIdentifierFromUrl('https://soundcloud.com/artist/sets/cool-playlist'),
    'cool-playlist'
  )
  assert.equal(extractIdentifierFromUrl('https://example.com/other'), null)
})

test('inferSourceNameFromUrl identifies music platform correctly', () => {
  assert.equal(inferSourceNameFromUrl('https://www.youtube.com/playlist?list=PL123'), 'youtube')
  assert.equal(inferSourceNameFromUrl('https://open.spotify.com/playlist/123'), 'spotify')
  assert.equal(inferSourceNameFromUrl('https://music.apple.com/us/playlist/123'), 'applemusic')
  assert.equal(inferSourceNameFromUrl('https://www.deezer.com/playlist/123'), 'deezer')
  assert.equal(inferSourceNameFromUrl('https://soundcloud.com/user/sets/123'), 'soundcloud')
  assert.equal(inferSourceNameFromUrl('https://tidal.com/playlist/123'), 'tidal')
  assert.equal(inferSourceNameFromUrl('https://unknown.com'), null)
})

test('buildPlaylistInfo handles complete playlist with all metadata', () => {
  const tracks = [
    createMockTrack({ length: 180000 }),
    createMockTrack({ length: 240000 })
  ]

  const info = buildPlaylistInfo(
    {
      name: 'Best of 2024',
      selectedTrack: 1,
      identifier: 'playlist-abc',
      uri: 'https://example.com/playlist/playlist-abc',
      artworkUrl: 'https://example.com/playlist-cover.jpg',
      author: 'DJ Awesome',
      authorUrl: 'https://example.com/dj-awesome',
      description: 'The best songs of 2024',
      sourceName: 'spotify',
      totalTracks: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-15T00:00:00.000Z'
    },
    {
      type: 'playlist'
    },
    tracks,
    { sourceName: 'spotify' }
  )

  assert.equal(info.name, 'Best of 2024')
  assert.equal(info.selectedTrack, 1)
  assert.equal(info.identifier, 'playlist-abc')
  assert.equal(info.uri, 'https://example.com/playlist/playlist-abc')
  assert.equal(info.artworkUrl, 'https://example.com/playlist-cover.jpg')
  assert.equal(info.author, 'DJ Awesome')
  assert.equal(info.authorUrl, 'https://example.com/dj-awesome')
  assert.equal('description' in info, false)
  assert.equal(info.sourceName, 'spotify')
  assert.equal(info.totalTracks, 2)
  assert.equal(info.loadedTracks, 2)
  assert.equal(info.loadedDuration, 420000)
  assert.equal(info.totalDuration, 420000)
  assert.equal('isPartial' in info, false)
  assert.equal(info.isAlbum, false)
  assert.equal(info.createdAt, '2024-01-01T00:00:00.000Z')
  assert.equal(info.updatedAt, '2024-01-15T00:00:00.000Z')
})

test('buildPlaylistInfo handles partially loaded playlist without reporting loaded duration as total duration', () => {
  const tracks = [
    createMockTrack({ length: 200000 }),
    createMockTrack({ length: 200000 })
  ]

  const info = buildPlaylistInfo(
    {
      name: 'Huge 500-Song Playlist',
      totalTracks: 500
    },
    {},
    tracks
  )

  assert.equal(info.loadedTracks, 2)
  assert.equal(info.totalTracks, 500)
  assert.equal(info.isPartial, true)
  assert.equal(info.loadedDuration, 400000)
  // Must NOT report loadedDuration as totalDuration when isPartial is true
  assert.equal(info.totalDuration, null)
})

test('buildPlaylistInfo uses explicit totalDuration when provided on partial playlist', () => {
  const tracks = [createMockTrack({ length: 200000 })]

  const info = buildPlaylistInfo(
    {
      name: 'Partial Playlist With Total Duration',
      totalTracks: 50,
      totalDuration: 10000000
    },
    {},
    tracks
  )

  assert.equal(info.isPartial, true)
  assert.equal(info.loadedTracks, 1)
  assert.equal(info.loadedDuration, 200000)
  assert.equal(info.totalDuration, 10000000)
})

test('buildPlaylistInfo correctly handles live streams and unknown durations', () => {
  const tracks = [
    createMockTrack({ length: 180000, isStream: false }),
    createMockTrack({ length: 0, isStream: true }), // Live stream
    createMockTrack({ length: -1, isStream: false }) // Unknown length
  ]

  const info = buildPlaylistInfo(
    { name: 'Radio & Streams Playlist' },
    {},
    tracks
  )

  assert.equal(info.loadedTracks, 3)
  assert.equal('isPartial' in info, false)
  // Only the 180000ms track is counted in loadedDuration
  assert.equal(info.loadedDuration, 180000)
  // Streams / unknown lengths make totalDuration indeterminate
  assert.equal(info.totalDuration, null)
})

test('buildPlaylistInfo handles empty playlists', () => {
  const info = buildPlaylistInfo(
    { name: 'Empty Playlist' },
    {},
    []
  )

  assert.equal(info.loadedTracks, 0)
  assert.equal(info.totalTracks, 0)
  assert.equal(info.loadedDuration, 0)
  assert.equal(info.totalDuration, 0)
  assert.equal('isPartial' in info, false)
  assert.equal(info.selectedTrack, -1)
})

test('buildPlaylistInfo prioritizes native playlist artwork over track artwork fallback', () => {
  const tracks = [
    createMockTrack({ artworkUrl: 'https://example.com/track-art.jpg' })
  ]

  // Case A: Playlist has native artwork
  const withNative = buildPlaylistInfo(
    { name: 'Test' },
    { artworkUrl: 'https://example.com/native-playlist-art.jpg' },
    tracks
  )
  assert.equal(withNative.artworkUrl, 'https://example.com/native-playlist-art.jpg')

  // Case B: Playlist artwork is absent -> fallback to track artwork
  const withFallback = buildPlaylistInfo(
    { name: 'Test' },
    {},
    tracks
  )
  assert.equal(withFallback.artworkUrl, 'https://example.com/track-art.jpg')

  // Case C: Neither has artwork -> null
  const noArtworkTracks = [createMockTrack({ artworkUrl: null })]
  const withNull = buildPlaylistInfo(
    { name: 'Test' },
    {},
    noArtworkTracks
  )
  assert.equal(withNull.artworkUrl, null)
})

test('buildPlaylistInfo accurately detects albums', () => {
  // Case A: pluginInfo type is album
  const albumA = buildPlaylistInfo({ name: 'Album A' }, { type: 'album' }, [])
  assert.equal(albumA.isAlbum, true)

  // Case B: YouTube Music album ID (OLAK...)
  const albumB = buildPlaylistInfo(
    { name: 'Album B', identifier: 'OLAK5uy_k123' },
    {},
    []
  )
  assert.equal(albumB.isAlbum, true)

  // Case C: Explicit isAlbum flag
  const albumC = buildPlaylistInfo({ name: 'Album C', isAlbum: true }, {}, [])
  assert.equal(albumC.isAlbum, true)

  // Case D: Ordinary playlist
  const playlist = buildPlaylistInfo({ name: 'Playlist D' }, { type: 'playlist' }, [])
  assert.equal(playlist.isAlbum, false)
})

test('buildPlaylistInfo handles explicit content detection', () => {
  // Track has explicit flag
  const explicitTrack = createMockTrack()
  ;(explicitTrack.info as unknown as Record<string, unknown>).isExplicit = true

  const cleanTrack = createMockTrack()
  ;(cleanTrack.info as unknown as Record<string, unknown>).isExplicit = false

  const indeterminateTrack = createMockTrack()

  // 1. Any track explicit -> true
  const infoExplicit = buildPlaylistInfo(
    { name: 'Explicit Playlist' },
    {},
    [cleanTrack, explicitTrack]
  )
  assert.equal(infoExplicit.isExplicit, true)

  // 2. All tracks determinably clean -> false
  const infoClean = buildPlaylistInfo(
    { name: 'Clean Playlist' },
    {},
    [cleanTrack, cleanTrack]
  )
  assert.equal(infoClean.isExplicit, false)

  // 3. Indeterminate tracks -> omitted (undefined)
  const infoIndeterminate = buildPlaylistInfo(
    { name: 'Indeterminate Playlist' },
    {},
    [indeterminateTrack]
  )
  assert.equal('isExplicit' in infoIndeterminate, false)
  assert.equal(infoIndeterminate.isExplicit, undefined)
})

test('buildPlaylistInfo preserves original playlist source even when tracks resolve via another source', () => {
  // Simulating Spotify playlist resolving tracks through YouTube
  const tracks = [
    createMockTrack({ sourceName: 'youtube' }),
    createMockTrack({ sourceName: 'youtube' })
  ]

  const info = buildPlaylistInfo(
    { name: 'Spotify Playlist' },
    { type: 'playlist' },
    tracks,
    { sourceName: 'spotify', url: 'https://open.spotify.com/playlist/abc' }
  )

  // Original playlist source 'spotify' is preserved
  assert.equal(info.sourceName, 'spotify')
  // Tracks keep their own sourceName
  assert.equal(tracks[0]!.info.sourceName, 'youtube')
})

test('buildPlaylistInfo uses null for missing metadata and omits optional null/false/generic fields', () => {
  const info = buildPlaylistInfo({ name: 'Minimal Playlist' }, {}, [])

  assert.equal(info.identifier, null)
  assert.equal(info.uri, null)
  assert.equal(info.artworkUrl, null)
  assert.equal(info.author, null)
  assert.equal(info.authorUrl, null)
  assert.equal('description' in info, false)
  assert.equal((info as unknown as Record<string, unknown>).description, undefined)
  assert.equal(info.sourceName, null)
  assert.equal('isPartial' in info, false)
  assert.equal(info.isPartial, undefined)
  assert.equal('isExplicit' in info, false)
  assert.equal(info.isExplicit, undefined)
  assert.equal('createdAt' in info, false)
  assert.equal(info.createdAt, undefined)
  assert.equal('updatedAt' in info, false)
  assert.equal(info.updatedAt, undefined)
})

test('normalizePlaylistResult normalizes playlist collections and leaves other results intact', () => {
  const track = createMockTrack()

  // Track result unchanged
  const trackResult: SourceResult = { loadType: 'track', data: track }
  const normalizedTrack = normalizePlaylistResult(trackResult)
  assert.equal(normalizedTrack.loadType, 'track')

  // Search result unchanged
  const searchResult: SourceResult = { loadType: 'search', data: [track] }
  const normalizedSearch = normalizePlaylistResult(searchResult)
  assert.equal(normalizedSearch.loadType, 'search')

  // Empty result unchanged
  const emptyResult: SourceResult = { loadType: 'empty', data: {} }
  const normalizedEmpty = normalizePlaylistResult(emptyResult)
  assert.equal(normalizedEmpty.loadType, 'empty')

  // Playlist result normalized
  const playlistResult: SourceResult = {
    loadType: 'playlist',
    data: {
      info: { name: 'My Playlist', selectedTrack: 0 },
      pluginInfo: { type: 'playlist' },
      tracks: [track]
    }
  }

  const normalizedPlaylist = normalizePlaylistResult(playlistResult, {
    sourceName: 'spotify',
    url: 'https://open.spotify.com/playlist/xyz'
  })

  assert.equal(normalizedPlaylist.loadType, 'playlist')
  assert.ok(normalizedPlaylist.data && 'info' in normalizedPlaylist.data)
  assert.equal(normalizedPlaylist.data.info.name, 'My Playlist')
  assert.equal(normalizedPlaylist.data.info.sourceName, 'spotify')
  assert.equal(normalizedPlaylist.data.info.loadedTracks, 1)
  assert.equal(normalizedPlaylist.data.info.loadedDuration, 180000)
  assert.equal(normalizedPlaylist.data.info.totalDuration, 180000)
  assert.equal('isPartial' in normalizedPlaylist.data.info, false)
  assert.equal(normalizedPlaylist.data.info.isAlbum, false)
  assert.equal(typeof normalizedPlaylist.data.info.identifier, 'string')
})

test('buildPlaylistInfo never adds description to metadata under any circumstances', () => {
  const genericInfo = buildPlaylistInfo(
    {
      name: 'Album Test',
      description: 'Share your videos with friends, family, and the world'
    },
    {},
    []
  )
  assert.equal('description' in genericInfo, false)

  const realInfo = buildPlaylistInfo(
    {
      name: 'Album Test',
      description: 'Real album description'
    },
    {},
    []
  )
  assert.equal('description' in realInfo, false)

  const randomInfo = buildPlaylistInfo(
    {
      name: 'Album Test',
      description: 'any custom description'
    },
    { description: 'plugin description' },
    []
  )
  assert.equal('description' in randomInfo, false)
})

test('buildPlaylistInfo conditionally includes isPartial, isExplicit, createdAt, and updatedAt', () => {
  // When isPartial is true, isExplicit is boolean, createdAt/updatedAt are strings -> included
  const info = buildPlaylistInfo(
    {
      name: 'Test',
      isPartial: true,
      isExplicit: false,
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01'
    },
    {},
    []
  )

  assert.equal(info.isPartial, true)
  assert.equal(info.isExplicit, false)
  assert.equal(info.createdAt, '2024-01-01T00:00:00.000Z')
  assert.equal(info.updatedAt, '2024-02-01T00:00:00.000Z')

  // When isPartial is false, isExplicit is null, createdAt/updatedAt are null -> omitted
  const emptyInfo = buildPlaylistInfo(
    {
      name: 'Test',
      isPartial: false,
      isExplicit: null,
      createdAt: null,
      updatedAt: null
    },
    {},
    []
  )

  assert.equal('isPartial' in emptyInfo, false)
  assert.equal('isExplicit' in emptyInfo, false)
  assert.equal('createdAt' in emptyInfo, false)
  assert.equal('updatedAt' in emptyInfo, false)
})
