import assert from 'node:assert/strict'
import test from 'node:test'
import { SpotifyArtistMediaCache } from './spotifyArtistMediaCache.ts'

const id = '6qqNVTkY8uBg9cP3Jd7DAH'
const image = { url: 'https://i.scdn.co/image/avatar' }
const banner = { url: 'https://i.scdn.co/image/banner' }

test('merges artist artwork and coalesces concurrent lookups', async () => {
  let calls = 0
  const cache = new SpotifyArtistMediaCache(async (artistId) => {
    calls++
    return { id: artistId, name: 'Artist', artwork: [image], banners: [banner] }
  })
  const artists = [{ id, name: 'Original', artwork: [image] }]
  const [first, second] = await Promise.all([
    cache.enrich(artists),
    cache.enrich(artists)
  ])
  assert.deepEqual(first, [{ ...artists[0], banners: [banner] }])
  assert.deepEqual(second, first)
  assert.equal(calls, 1)
  await cache.enrich(artists)
  assert.equal(calls, 1)
})

test('expires successful results and does not cache failures or wrong IDs', async () => {
  let time = 0
  let calls = 0
  const cache = new SpotifyArtistMediaCache(
    async (artistId) => {
      calls++
      if (calls === 1) throw new Error('network')
      if (calls === 2) return { id: 'wrong', name: 'Wrong', artwork: [image] }
      return { id: artistId, name: 'Artist', banners: [banner] }
    },
    () => time
  )
  const artists = [{ id, name: 'Artist' }]
  assert.deepEqual(await cache.enrich(artists), artists)
  assert.deepEqual(await cache.enrich(artists), artists)
  assert.equal((await cache.enrich(artists))[0]?.banners?.length, 1)
  time += 15 * 60_000
  await cache.enrich(artists)
  assert.equal(calls, 4)
})

test('limits per-track requests and preserves artist order', async () => {
  const ids = ['A', 'B', 'C', 'D'].map((value) => value.repeat(22))
  const calls: string[] = []
  const cache = new SpotifyArtistMediaCache(async (artistId) => {
    calls.push(artistId)
    return { id: artistId, name: 'Artist', banners: [banner] }
  })
  const artists = ids.map((artistId) => ({ id: artistId, name: artistId }))
  const result = await cache.enrich(artists)
  assert.deepEqual(calls, ids.slice(0, 3))
  assert.deepEqual(
    result.map((artist) => artist.id),
    ids
  )
  assert.equal(result[3]?.banners, undefined)
})
