import { performance } from 'node:perf_hooks'
import { serialize, deserialize } from 'node:v8'
import { buildSpotifyMedia } from '../src/modules/spotifyMedia.ts'
import { appleMusicArtists } from '../src/modules/appleMusicMedia.ts'
import { buildAmazonMedia } from '../src/modules/amazonMusicMedia.ts'
import { buildTrackMedia, type TrackMediaMetadata } from '../src/modules/trackMedia.ts'

const parsed = Number(process.argv[2] ?? 100000)
if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 1000000) {
  throw new Error('Iterations must be an integer from 1000 to 1000000')
}
const iterations = parsed
const image = { url: 'https://example.com/cover.jpg', width: 640, height: 640 }
const track = { author: 'Example artist', isrc: 'USUG11904206', artworkUrl: image.url }
const spotify = {
  artists: [{ name: 'Example artist', id: 'artist1', images: [image] }],
  album: { id: 'album1', name: 'Example album', images: [image] },
  external_ids: { isrc: track.isrc }
}
const apple = [{ id: 'artist1', attributes: { name: 'Example artist', artwork: image } }]
const amazon = { byArtist: { name: 'Example artist' }, inAlbum: { name: 'Example album' }, image: image.url }
const cases: Array<[string, () => TrackMediaMetadata]> = [
  ['Spotify normalization', () => buildSpotifyMedia(spotify)],
  ['Apple Music normalization', () => buildTrackMedia('applemusic', {
    artists: appleMusicArtists(apple), album: { name: 'Example album', artwork: [image] },
    identifiers: { isrc: track.isrc }, credits: [{ name: 'Example composer', role: 'composer' }]
  })],
  ['Amazon Music normalization', () => buildAmazonMedia(track, amazon)],
  ['Holo normalization', () => buildTrackMedia('youtube', {
    artwork: [image], channel: { id: 'channel1', name: 'Channel', artwork: [image], banners: [{ url: 'https://example.com/banner.jpg' }] }
  })]
]

function measure(name: string, operation: () => unknown) {
  let result: unknown
  for (let i = 0; i < 5000; i++) result = operation()
  const samples: number[] = []
  const batch = Math.ceil(iterations / 100)
  for (let start = 0; start < iterations; start += batch) {
    const count = Math.min(batch, iterations - start)
    const before = performance.now()
    for (let i = 0; i < count; i++) result = operation()
    samples.push((performance.now() - before) * 1000 / count)
  }
  samples.sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    case: name,
    'mean us/op': Number(mean.toFixed(3)),
    'p95 batch us/op': Number((samples[Math.ceil(samples.length * 0.95) - 1] ?? 0).toFixed(3)),
    'JSON bytes': Buffer.byteLength(JSON.stringify(result) ?? '')
  }
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, iterations }))
const results = cases.map(([name, operation]) => measure(name, operation))
const payload = cases.map(([, operation]) => operation())
results.push(measure('JSON round trip (4 tracks)', () => JSON.parse(JSON.stringify(payload))))
results.push(measure('V8 round trip (4 tracks)', () => deserialize(serialize(payload))))
console.table(results)
