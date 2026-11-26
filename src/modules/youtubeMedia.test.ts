import assert from 'node:assert/strict'
import test from 'node:test'
import { buildYouTubeMedia, youtubeImages } from './youtubeMedia.ts'

const id = 'UCabcdefghijklmnopqrstuv'
const video = 'abcdefghijk'
const info = {
  sourceName: 'youtube',
  identifier: video,
  author: 'Uploader',
  artworkUrl: 'https://i.ytimg.com/legacy.jpg'
}
const thumb = {
  url: 'https://i.ytimg.com/image.jpg?keep=1',
  width: 480,
  height: 360
}
const avatar = {
  url: 'https://yt3.ggpht.com/avatar=s88',
  width: 88,
  height: 88
}
const banner = {
  url: 'https://yt3.ggpht.com/banner=w1000',
  width: 1000,
  height: 200
}

test('retains exact thumbnail sizes and channel images without guessing artist identity', () => {
  const media = buildYouTubeMedia(
    info,
    { thumbnail: { thumbnails: [thumb] } },
    {
      videoDetails: {
        videoId: video,
        channelId: id,
        author: 'Uploader',
        thumbnail: { thumbnails: [thumb] }
      }
    },
    { id, name: 'Uploader', artwork: [avatar], banners: [banner] }
  )
  assert.equal(media.artwork?.length, 2)
  assert.deepEqual(media.artwork?.[0], thumb)
  assert.deepEqual(media.channel?.artwork, [avatar])
  assert.deepEqual(media.channel?.banners, [banner])
  assert.equal(media.artists.length, 0)
})
const run = (name: string, id: string, pageType: string) => ({
  text: name,
  navigationEndpoint: {
    browseEndpoint: {
      browseId: id,
      browseEndpointContextSupportedConfigs: {
        browseEndpointContextMusicConfig: { pageType }
      }
    }
  }
})
test('music artist and album roles come only from typed navigation links', () => {
  const media = buildYouTubeMedia(
    { ...info, sourceName: 'ytmusic' },
    {
      flexColumns: [
        {},
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                run('Artist', id, 'MUSIC_PAGE_TYPE_ARTIST'),
                { text: ' • ' },
                run('Album', 'MPREb_example', 'MUSIC_PAGE_TYPE_ALBUM'),
                run('Playlist', 'VLxyz', 'MUSIC_PAGE_TYPE_PLAYLIST')
              ]
            }
          }
        }
      ]
    },
    undefined
  )
  assert.equal(media.artists[0]?.id, id)
  assert.equal(media.artists.length, 1)
  assert.equal(media.album?.id, 'MPREb_example')
  assert.equal(media.channel, undefined)
  assert.equal(media.album?.artwork, undefined)
})
test('rejects mismatched player and channel metadata and invalid images', () => {
  const media = buildYouTubeMedia(
    info,
    {},
    {
      videoDetails: {
        videoId: 'other',
        channelId: id,
        thumbnail: { thumbnails: [thumb] }
      }
    }
  )
  assert.equal(media.channel, undefined)
  assert.equal(media.artwork?.length, 1)
  assert.equal(
    youtubeImages([
      { url: 'http://bad.invalid/a' },
      { url: '//yt3.ggpht.com/a', width: 0, height: 88 }
    ]).length,
    1
  )
})
