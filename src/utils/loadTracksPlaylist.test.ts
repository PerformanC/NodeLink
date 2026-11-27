import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  NormalizedPlaylistInfo,
  PlaylistData,
  SourceResult,
  TrackData
} from '../typings/sources/source.types.ts'
import {
  buildPlaylistInfo,
  normalizePlaylistData,
  normalizePlaylistResult
} from './playlistNormalizer.ts'

function createSampleTrack(
  title: string,
  length: number,
  isStream = false,
  artworkUrl: string | null = null,
  isExplicit: boolean | null = null
): TrackData {
  return {
    encoded: Buffer.from(`track-${title}`).toString('base64'),
    info: {
      identifier: `id-${title}`,
      isSeekable: !isStream,
      author: 'Sample Artist',
      length,
      isStream,
      position: 0,
      title,
      uri: `https://example.com/track/${encodeURIComponent(title)}`,
      artworkUrl,
      isrc: null,
      sourceName: 'youtube',
      ...(isExplicit !== null ? { isExplicit } : {})
    },
    pluginInfo: {}
  }
}

test('Integration: Spotify album normalization with track resolution through YouTube', () => {
  // Simulates a Spotify album resolution where individual tracks are mirrored to YouTube
  const rawSpotifyAlbumResult: SourceResult = {
    loadType: 'playlist',
    data: {
      info: {
        name: 'Random Access Memories',
        selectedTrack: 0
      },
      pluginInfo: {
        type: 'album',
        identifier: '4m2880jivSbbyEGAKfITCa',
        url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa',
        artworkUrl: 'https://i.scdn.co/image/ab67616d0000b273',
        author: 'Daft Punk',
        authorUrl: 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYxwDoODt',
        totalTracks: 13,
        isAlbum: true,
        createdAt: '2013-05-17'
      },
      tracks: [
        createSampleTrack('Give Life Back to Music', 275000, false, 'https://i.ytimg.com/vi/1.jpg'),
        createSampleTrack('Get Lucky', 369000, false, 'https://i.ytimg.com/vi/2.jpg')
      ]
    }
  }

  const normalized = normalizePlaylistResult(rawSpotifyAlbumResult, {
    sourceName: 'spotify',
    url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'
  })

  assert.equal(normalized.loadType, 'playlist')
  const info = normalized.data.info as NormalizedPlaylistInfo

  // 18 Fields Verification
  assert.equal(info.name, 'Random Access Memories')
  assert.equal(info.selectedTrack, 0)
  assert.equal(info.identifier, '4m2880jivSbbyEGAKfITCa')
  assert.equal(info.uri, 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa')
  assert.equal(info.artworkUrl, 'https://i.scdn.co/image/ab67616d0000b273')
  assert.equal(info.author, 'Daft Punk')
  assert.equal(info.authorUrl, 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYxwDoODt')
  assert.equal('description' in info, false)
  assert.equal(info.sourceName, 'spotify') // Preserves 'spotify' even though tracks are YouTube
  assert.equal(info.totalTracks, 13)
  assert.equal(info.loadedTracks, 2)
  assert.equal(info.isPartial, true) // 13 total > 2 loaded
  assert.equal(info.isAlbum, true)
  assert.equal(info.loadedDuration, 644000)
  assert.equal(info.totalDuration, null) // Partial playlist must not report loaded duration
  assert.equal('isExplicit' in info, false)
  assert.equal(info.createdAt, '2013-05-17T00:00:00.000Z')
  assert.equal('updatedAt' in info, false)

  // Verify tracks and pluginInfo are preserved
  assert.ok(normalized.data && 'tracks' in normalized.data)
  assert.equal(normalized.data.tracks.length, 2)
  assert.deepEqual(normalized.data.tracks[0]!.userData, {})
  assert.equal(normalized.data.pluginInfo.type, 'album')
})

test('Integration: YouTube playlist with fallback artwork and complete duration', () => {
  const rawYouTubeResult: SourceResult = {
    loadType: 'playlist',
    data: {
      info: {
        name: 'Chill Vibes',
        selectedTrack: 0
      },
      pluginInfo: {
        type: 'playlist',
        identifier: 'PL12345',
        url: 'https://www.youtube.com/playlist?list=PL12345',
        artworkUrl: '', // No playlist-level artwork
        author: 'Lofi Girl',
        authorUrl: 'https://www.youtube.com/@LofiGirl',
        description: 'Beats to relax/study to',
        totalTracks: 2
      },
      tracks: [
        createSampleTrack('Study Session', 120000, false, 'https://i.ytimg.com/vi/fallback1.jpg'),
        createSampleTrack('Coffee Break', 180000, false, 'https://i.ytimg.com/vi/fallback2.jpg')
      ]
    }
  }

  const normalized = normalizePlaylistResult(rawYouTubeResult, {
    sourceName: 'youtube',
    url: 'https://www.youtube.com/playlist?list=PL12345'
  })

  const info = normalized.data.info as NormalizedPlaylistInfo
  // Artwork fallback should pick the first track's artwork
  assert.equal(info.artworkUrl, 'https://i.ytimg.com/vi/fallback1.jpg')
  assert.equal('isPartial' in info, false)
  assert.equal(info.totalTracks, 2)
  assert.equal(info.loadedTracks, 2)
  assert.equal(info.loadedDuration, 300000)
  assert.equal(info.totalDuration, 300000) // Complete playlist reports full duration
  assert.equal(info.description, 'Beats to relax/study to')
  assert.equal(info.sourceName, 'youtube')
})

test('Integration: Playlist containing live streams handles duration gracefully', () => {
  const rawResult: SourceResult = {
    loadType: 'playlist',
    data: {
      info: {
        name: 'Live Radio Collection',
        selectedTrack: 0
      },
      pluginInfo: {
        identifier: 'radio-123'
      },
      tracks: [
        createSampleTrack('Recorded Intro', 30000, false),
        createSampleTrack('Live Broadcast', 0, true) // Stream!
      ]
    }
  }

  const normalized = normalizePlaylistResult(rawResult)
  const info = normalized.data.info as NormalizedPlaylistInfo

  assert.equal(info.loadedTracks, 2)
  assert.equal('isPartial' in info, false)
  // Only the non-stream track is summed
  assert.equal(info.loadedDuration, 30000)
  // Stream causes totalDuration to be null
  assert.equal(info.totalDuration, null)
  assert.equal('isPartial' in info, false)
})

test('Integration: Bare minimum source output produces standard fields with nulls and omits optional null/false fields', () => {
  const bareResult: SourceResult = {
    loadType: 'playlist',
    data: {
      info: {
        name: 'Bare Playlist',
        selectedTrack: 0
      },
      pluginInfo: {},
      tracks: []
    }
  }

  const normalized = normalizePlaylistResult(bareResult)
  const info = normalized.data.info as NormalizedPlaylistInfo

  const standardFields: Array<keyof NormalizedPlaylistInfo> = [
    'name',
    'selectedTrack',
    'identifier',
    'uri',
    'artworkUrl',
    'author',
    'authorUrl',
    'sourceName',
    'totalTracks',
    'loadedTracks',
    'totalDuration',
    'loadedDuration',
    'isAlbum'
  ]

  for (const field of standardFields) {
    assert.ok(field in info, `Field "${field}" missing from data.info`)
  }

  // Optional fields omitted when null/false
  assert.equal('description' in info, false)
  assert.equal('isPartial' in info, false)
  assert.equal('isExplicit' in info, false)
  assert.equal('createdAt' in info, false)
  assert.equal('updatedAt' in info, false)

  assert.equal(info.name, 'Bare Playlist')
  assert.equal(info.selectedTrack, -1) // empty playlist
  assert.equal(info.identifier, null)
  assert.equal(info.uri, null)
  assert.equal(info.artworkUrl, null)
  assert.equal(info.author, null)
  assert.equal(info.authorUrl, null)
  assert.equal(info.sourceName, null)
  assert.equal(info.totalTracks, 0)
  assert.equal(info.loadedTracks, 0)
  assert.equal(info.loadedDuration, 0)
  assert.equal(info.totalDuration, 0)
  assert.equal(info.isAlbum, false)
})
