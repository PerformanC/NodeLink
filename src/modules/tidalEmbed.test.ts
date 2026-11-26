import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchTidalEmbed, parseTidalEmbed } from './tidalEmbed.ts'

const artwork = [80, 160, 320, 640, 750, 1080, 1280].map(size => ({
  sizes: size + 'x' + size, src: 'https://resources.tidal.com/images/b66a5c40/c34d/4507/a0dc/5f98e46fdd20/' + size + 'x' + size + '.jpg'
}))
const data = { '20115564': { title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams, Nile Rodgers', album: 'Random Access Memories', artwork } }
const main = '<a href="https://tidal.com/artist/8847">Daft Punk</a>'
const guests = '<a href="https://tidal.com/artist/4900204">Pharrell Williams</a><a href="https://tidal.com/artist/30528">Nile Rodgers</a>'
const script = '<script>\nwindow.tidalMediaSessionMetadata=' + JSON.stringify(data) + ';\n</script>'
const single = script + '<tidal-play-trigger product-id="20115564" product-type="track"><span class="media-artist">' + main + guests + '</span><tidal-duration-time>370</tidal-duration-time>'
const album = script + '<tidal-play-trigger product-id="20115556" product-type="album"><h1 class="media-album" title="Album"><a href="https://tidal.com/album/20115556">Random Access Memories</a></h1><span class="media-artist">' + main + '</span><tidal-duration-time>30</tidal-duration-time><list-item product-id="20115564" product-type="track"><span slot="artist">' + guests + '</span><time slot="duration">6:10</time></list-item>'

test('reads track artwork and exact artist IDs from public embed data', () => {
  const item = parseTidalEmbed(single, 'track', '20115564')?.tracks[0]
  assert.equal(item?.durationMs, 370000)
  assert.deepEqual(item?.media.artists.map(artist => artist.id), ['8847', '4900204', '30528'])
  assert.equal(item?.media.album?.artwork?.length, 7)
  assert.equal(item?.media.album?.artwork?.[0]?.width, 1280)
  assert.equal(item?.media.album?.id, undefined)
  assert.equal(item?.media.identifiers, undefined)
  assert.equal(parseTidalEmbed(single, 'track', '123'), undefined)
})

test('uses actual album row durations and does not mistake preview length for track duration', () => {
  const result = parseTidalEmbed(album, 'album', '20115556')
  assert.equal(result?.name, 'Random Access Memories')
  assert.equal(result?.tracks[0]?.durationMs, 370000)
  assert.equal(result?.tracks[0]?.media.album?.id, '20115556')
  assert.equal(result?.tracks[0]?.media.artists.length, 3)
})

test('rejects malformed payloads and never sends credentials', async () => {
  const result = await fetchTidalEmbed('track', '20115564', async (url, init) => {
    assert.equal(url, 'https://embed.tidal.com/tracks/20115564')
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    assert.equal(new Headers(init?.headers).has('x-tidal-token'), false)
    assert.equal(init?.redirect, 'error')
    return new Response(single, { headers: { 'content-type': 'text/html' } })
  })
  assert.equal(result?.tracks.length, 1)
  assert.equal(parseTidalEmbed(single.replace('370</', '0</'), 'track', '20115564'), undefined)
  assert.equal(parseTidalEmbed(single.replace('window.tidalMediaSessionMetadata=', 'other='), 'track', '20115564'), undefined)
  assert.equal(await fetchTidalEmbed('track', '20115564', async () => new Response('', { status: 403 })), undefined)
})
