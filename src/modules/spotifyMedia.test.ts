import assert from 'node:assert/strict'
import test from 'node:test'
import { readSpotifyMetadataIsrc, normalizeSpotifyDynamicColors, readOfficialSpotifyIsrc, buildSpotifyArtistMedia, buildSpotifyMedia, spotifyCanvasMedia, selectSpotifyCanvas, spotifyCanvasSessionState } from './spotifyMedia.ts'

test('normalizes official artist and album metadata with image dimensions', () => {
  assert.deepEqual(buildSpotifyMedia({ artists: [{ id: 'a', name: 'Artist' }], album: { id: 'b', name: 'Album', images: [{ url: 'https://example.com/cover', width: 640, height: 640 }] } }), {
    provider: 'spotify', artists: [{ id: 'a', name: 'Artist' }], album: { id: 'b', name: 'Album', artwork: [{ url: 'https://example.com/cover', width: 640, height: 640 }] }
  })
})

test('supports internal primary and secondary artists', () => {
  assert.deepEqual(buildSpotifyMedia({ firstArtist: { items: [{ uri: 'spotify:artist:a', profile: { name: 'A' } }] }, otherArtists: { items: [{ name: 'B' }] } }).artists, [{ name: 'A', id: 'a' }, { name: 'B' }])
})

test('deduplicates artwork and rejects unsafe URLs and invalid dimensions', () => {
  assert.deepEqual(buildSpotifyMedia({ album: { images: [{ url: 'https://example.com/a', width: 100 }, { url: 'https://example.com/a', height: 100 }, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/a' }, { url: 'https://example.com/b', width: -1 }] } }).album?.artwork, [{ url: 'https://example.com/a', width: 100, height: 100 }, { url: 'https://example.com/b' }])
})

test('omits unavailable metadata and accepts fallback artwork', () => {
  assert.deepEqual(buildSpotifyMedia({}), { provider: 'spotify', artists: [] })
  assert.deepEqual(buildSpotifyMedia({}, 'https://example.com/fallback').album, { artwork: [{ url: 'https://example.com/fallback' }] })
})

test('normalizes Canvas only for the matching track and a safe URL', () => {
  const entry = { id: 'c', canvasUrl: 'https://canvaz.scdn.co/c.mp4', trackUri: 'spotify:track:a' }
  assert.deepEqual(spotifyCanvasMedia(entry, 'spotify:track:a'), { id: 'c', url: entry.canvasUrl })
  assert.equal(spotifyCanvasMedia(entry, 'spotify:track:b'), undefined)
  assert.equal(spotifyCanvasMedia({ canvasUrl: 'file:///tmp/c.mp4' }, 'spotify:track:a'), undefined)
})

test('selects a valid matching Canvas even after unrelated or unusable entries', () => {
  const target = 'spotify:track:target'
  const valid = { id: 'correct', trackUri: target, canvasUrl: 'https://canvaz.scdn.co/loop.mp4' }
  const unrelated = { id: 'wrong', trackUri: 'spotify:track:other', canvasUrl: valid.canvasUrl }
  const unsafe = { id: 'unsafe', trackUri: target, canvasUrl: 'file:///tmp/loop.mp4' }
  assert.deepEqual(selectSpotifyCanvas([unrelated, unsafe, valid], target), {
    entry: valid, canvas: { id: valid.id, url: valid.canvasUrl }
  })
  assert.equal(selectSpotifyCanvas([unrelated, unsafe], target), undefined)
  assert.equal(selectSpotifyCanvas(undefined, target), undefined)
})

test('classifies Canvas session availability without exposing credentials', () => {
  assert.equal(spotifyCanvasSessionState(null, 2000, 1000), 'missing')
  assert.equal(spotifyCanvasSessionState('  ', 2000, 1000), 'missing')
  assert.equal(spotifyCanvasSessionState('fixture', 1000, 1000), 'expired')
  assert.equal(spotifyCanvasSessionState('fixture', 999, 1000), 'expired')
  assert.equal(spotifyCanvasSessionState('fixture', null, 1000), 'unknown-expiry')
  assert.equal(spotifyCanvasSessionState('fixture', Number.NaN, 1000), 'unknown-expiry')
  assert.equal(spotifyCanvasSessionState('fixture', 1001, 1000), 'ready')
})

test('preserves optional Canvas playback metadata in the public media contract', () => {
  const entry = { id: 'abc', trackUri: 'spotify:track:a', canvasUrl: 'https://canvaz.scdn.co/example.mp4', canvasUri: 'spotify:canvas:abc', fileId: '0123456789abcdef0123456789abcdef', type: 'VIDEO_LOOPING_RANDOM' }
  assert.deepEqual(selectSpotifyCanvas([entry], entry.trackUri)?.canvas, { url: entry.canvasUrl, id: entry.id, uri: entry.canvasUri, fileId: entry.fileId, type: entry.type })
  assert.deepEqual(spotifyCanvasMedia({ ...entry, canvasUri: 'invalid', fileId: 'bad', type: 'bad type' }, entry.trackUri), { url: entry.canvasUrl, id: entry.id })
})

test('normalizes artist overview avatar, gallery and header without mixing their roles', () => {
  const image = { url: 'https://i.scdn.co/image/avatar', width: 640, height: 640 }
  const gallery = { url: 'https://i.scdn.co/image/gallery', width: 1000, height: 1000 }
  const header = { url: 'https://i.scdn.co/image/header', width: 2000, height: 800 }
  const input = { id: 'abc', uri: 'spotify:artist:abc', profile: { name: 'Artist' }, visuals: { avatarImage: { sources: [image] }, gallery: { items: [{ sources: [gallery, image] }, null] } }, headerImage: { data: { sources: [header] } } }
  assert.deepEqual(buildSpotifyArtistMedia(input, 'abc'), { provider: 'spotify', artists: [{ id: 'abc', name: 'Artist', artwork: [image, gallery], banners: [header] }] })
  assert.equal(buildSpotifyArtistMedia(input, 'other'), undefined)
})

test('supports official artist images and omits invalid or unavailable optional fields', () => {
  assert.deepEqual(buildSpotifyArtistMedia({ id: 'abc', name: ' Artist ', images: [{ url: 'https://example.com/a' }, { url: 'http://example.com/b' }] }, 'abc'), { provider: 'spotify', artists: [{ id: 'abc', name: 'Artist', artwork: [{ url: 'https://example.com/a' }] }] })
  assert.equal(buildSpotifyArtistMedia({ profile: { name: 12 } }, 'abc'), undefined)
  assert.deepEqual(buildSpotifyArtistMedia({ name: 'Artist', visuals: { gallery: { items: 12 } }, headerImage: { data: { sources: false } } }, 'abc'), { provider: 'spotify', artists: [{ id: 'abc', name: 'Artist' }] })
})

test('reads and validates ISRC from the exact official catalog track', () => {
  const track = { id: 'abc', external_ids: { isrc: 'us-ug1-22-05736' } }
  assert.equal(readOfficialSpotifyIsrc(track, 'abc'), 'USUG12205736')
  assert.equal(readOfficialSpotifyIsrc({ ...track, id: 'other', linked_from: { id: 'abc' } }, 'abc'), undefined)
  assert.equal(readOfficialSpotifyIsrc({ id: 'abc', external_ids: { isrc: 'invalid' } }, 'abc'), undefined)
  assert.equal(readOfficialSpotifyIsrc({ id: 'abc', external_ids: null }, 'abc'), undefined)
  assert.equal(readOfficialSpotifyIsrc(null, 'abc'), undefined)
})

import { mediaDetails } from './trackMedia.ts'

test('normalizes single-image dynamic palettes with all contrast modes', () => {
  const rgb = (red: number, green: number, blue: number) => ({ red, green, blue, alpha: 255 })
  const result = normalizeSpotifyDynamicColors({ dynamicColors: [{ status: 'OK', bestFit: 'DARK',
    dark: { encoreBaseSetTextColor: rgb(151, 192, 222), highContrast: { backgroundBase: rgb(8, 48, 72), textBase: rgb(255, 255, 255) }, higherContrast: { textBrightAccent: rgb(30, 215, 96) }, minContrast: { textSubdued: rgb(255, 255, 255) } },
    light: { highContrast: { backgroundBase: rgb(196, 238, 255), textBase: rgb(0, 0, 0) } }
  }] })
  assert.deepEqual(result, { dark: '#083048', light: '#C4EEFF', palette: { bestFit: 'dark',
    dark: { encoreBaseSetTextColor: '#97C0DE', highContrast: { backgroundBase: '#083048', textBase: '#FFFFFF' }, higherContrast: { textBrightAccent: '#1ED760' }, minContrast: { textSubdued: '#FFFFFF' } },
    light: { highContrast: { backgroundBase: '#C4EEFF', textBase: '#000000' } } } })
  assert.deepEqual(mediaDetails({ colors: result }).colors, result)
})

test('rejects ambiguous, failed and malformed dynamic palettes', () => {
  const invalid = { status: 'OK', dark: { highContrast: { backgroundBase: { red: 256, green: 0, blue: 0, alpha: 255 }, textBase: { red: 0, green: 0, blue: 0, alpha: 128 } } } }
  assert.equal(normalizeSpotifyDynamicColors({ dynamicColors: [invalid] }), undefined)
  assert.equal(normalizeSpotifyDynamicColors({ dynamicColors: [invalid, invalid] }), undefined)
  assert.equal(normalizeSpotifyDynamicColors({ dynamicColors: [{ status: 'ERROR' }] }), undefined)
  assert.equal(normalizeSpotifyDynamicColors(null), undefined)
  assert.deepEqual(mediaDetails({ colors: { dark: '#ffffff', palette: { bestFit: 'dark', dark: { highContrast: { textBase: 'bad' } } } } }), { colors: { dark: '#FFFFFF' } })
})

test('reads only unambiguous explicitly typed legacy ISRCs', () => {
  assert.equal(readSpotifyMetadataIsrc({ external_id: [{ type: 'upc', id: 'USUG12205736' }, { type: 'isrc', id: 'usug12205736' }] }), 'USUG12205736')
  assert.equal(readSpotifyMetadataIsrc({ external_id: [{ type: 'isrc', id: 'USUG12205736' }, { type: 'isrc', id: 'USUG12205737' }] }), undefined)
  assert.equal(readSpotifyMetadataIsrc({ external_id: [{ type: 'upc', id: 'USUG12205736' }] }), undefined)
  assert.equal(readSpotifyMetadataIsrc({ external_id: {} }), undefined)
  assert.equal(readSpotifyMetadataIsrc('USUG12205736'), undefined)
})

test('rejects non-provider Canvas domains, credentials and custom ports', () => {
  const trackUri = 'spotify:track:a'
  for (const canvasUrl of [
    'https://canvaz.scdn.co.attacker.test/a.mp4',
    'https://attacker.test/a.mp4',
    'https://user@canvaz.scdn.co/a.mp4',
    'https://canvaz.scdn.co:8443/a.mp4',
    'http://canvaz.scdn.co/a.mp4'
  ]) assert.equal(spotifyCanvasMedia({ trackUri, canvasUrl }, trackUri), undefined)
})
