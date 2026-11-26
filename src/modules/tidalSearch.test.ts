import assert from 'node:assert/strict'
import test from 'node:test'
import { matchingTidalAlbum, tidalSearch } from './tidalSearch.ts'

const query = 'Billie Eilish bad guy'
const denial = new Error('Status 401')
const items = [
  { id: 20115564, title: 'Get Lucky' },
  { id: 20115565, title: 'Beyond' }
]

test('successful general search never invokes the alternate route', async () => {
  const calls: string[] = []
  const result = await tidalSearch(
    query,
    1,
    async (endpoint) => {
      calls.push(endpoint)
      return { tracks: { items } }
    },
    true,
    () => true
  )
  assert.deepEqual(calls, ['search'])
  assert.deepEqual(result, [items[0]])
})

test('401 may use one opted-in track-specific request with the same query', async () => {
  const calls: string[] = []
  const result = await tidalSearch(
    query,
    2,
    async (endpoint, params) => {
      calls.push(endpoint)
      assert.equal(params.query, query)
      if (endpoint === 'search') throw denial
      return { items }
    },
    true,
    (error) => error === denial
  )
  assert.deepEqual(calls, ['search', 'search/tracks'])
  assert.deepEqual(result, items)
})

test('unauthorized responses remain errors if both requests fail, or alternate is disabled', async () => {
  for (const enabled of [true, false]) {
    let calls = 0
    await assert.rejects(
      tidalSearch(
        query,
        10,
        async () => {
          calls++
          throw denial
        },
        enabled,
        (error) => error === denial
      ),
      (error) => error === denial
    )
    assert.equal(calls, enabled ? 2 : 1)
  }
})

test('album enrichment accepts only matching catalog IDs', () => {
  const album = {
    id: 20115556,
    upc: '886443927087',
    releaseDate: '2013-05-20',
    numberOfTracks: 13
  }
  assert.deepEqual(matchingTidalAlbum(album, '20115556'), album)
  assert.equal(matchingTidalAlbum(album, '20115564'), undefined)
})
