import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseOfficialTidalSearch,
  TidalOfficialClient
} from './tidalOfficial.ts'

const link = (type: string, id: string) => ({ type, id })
const rel = (type: string, id: string) => ({ data: [link(type, id)] })
const document = {
  data: [
    {
      type: 'searchResults',
      id: 'opaque',
      relationships: {
        tracks: { data: [link('tracks', '20115564'), link('tracks', '999')] }
      }
    }
  ],
  included: [
    {
      type: 'tracks',
      id: '20115564',
      attributes: {
        title: 'Get Lucky',
        duration: 'PT6M10S',
        isrc: 'USQX91300108',
        popularity: 0.89
      },
      relationships: {
        artists: rel('artists', '8847'),
        albums: rel('albums', '20115556')
      }
    },
    { type: 'artists', id: '8847', attributes: { name: 'Daft Punk' } },
    {
      type: 'albums',
      id: '20115556',
      attributes: {
        title: 'Random Access Memories',
        barcodeId: '886443927087',
        releaseDate: '2013-05-20',
        numberOfItems: 13
      },
      relationships: { coverArt: rel('artworks', 'cover') }
    },
    {
      type: 'artworks',
      id: 'cover',
      attributes: {
        mediaType: 'IMAGE',
        files: [
          {
            href: 'https://resources.tidal.com/images/example/640x640.jpg',
            meta: { width: 640, height: 640 }
          }
        ]
      }
    },
    {
      type: 'tracks',
      id: 'unlinked',
      attributes: { title: 'Unrelated', duration: 'PT3M' }
    }
  ]
}
test('v2 search normalizes only linked tracks and known metadata', () => {
  const result = parseOfficialTidalSearch(document, 10)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.durationMs, 370000)
  assert.equal(result[0]?.media.identifiers?.upc, '886443927087')
  assert.equal(result[0]?.media.catalog?.popularity, 89)
  assert.equal(result[0]?.media.album?.trackCount, 13)
  assert.equal(result[0]?.media.album?.artwork?.[0]?.width, 640)
})
test('authorized v2 search uses documented URL and bearer token', async () => {
  const client = new TidalOfficialClient(async (url, init) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://openapi.tidal.com')
    assert.equal(parsed.pathname, '/v2/searchResults')
    assert.equal(parsed.searchParams.get('filter[query]'), 'Get Lucky')
    assert.equal(
      new Headers(init.headers).get('Authorization'),
      'Bearer test-token'
    )
    assert.equal(init.redirect, 'error')
    return Response.json(document)
  })
  assert.equal(
    (
      await client.search('Get Lucky', 'US', 10, {
        metadataAccessToken: 'test-token'
      })
    ).length,
    1
  )
})
test('OAuth client credentials are cached and not sent to catalog endpoint', async () => {
  let calls = 0
  const client = new TidalOfficialClient(async (url, init) => {
    calls++
    assert.equal(url, 'https://auth.tidal.com/v1/oauth2/token')
    assert.equal(init.method, 'POST')
    assert.equal(String(init.body), 'grant_type=client_credentials')
    return Response.json({ access_token: 'mock', expires_in: 3600 })
  })
  const config = { clientId: 'test-id', clientSecret: 'test-secret' }
  assert.deepEqual(
    await Promise.all([client.accessToken(config), client.accessToken(config)]),
    ['mock', 'mock']
  )
  assert.equal(await client.accessToken(config), 'mock')
  assert.equal(calls, 1)
})
