/*
Any of the settings below can be disabled by setting them to false.

opt: 1 = Performance, 2 = Quality
threshold: 5000 = 5 seconds
playerUpdateInterval: 5000 = 5 seconds
statsInterval: 5000 = 5 seconds
autoUpdate: [ autoUpdate, interval, [tar, zip] ]
*/

export default {
  version: '1.4.0',
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    opt: 2,
    threshold: 5000,
    playerUpdateInterval: 5000,
    statsInterval: 5000,
    autoUpdate: [ true, false, 'tar' ],
    maxResults: 20,
    maxPlaylistSize: 20
  },
  debug: {
    showReqBody: true
  },
  search: {
    defaultSearchSource: 'youtube',
    sources: {
      youtube: true,
      youtubeMusic: true,
      spotify: true,
      deezer: true,
      bandcamp: true,
      http: true,
      local: true,
      pandora: true,
      soundcloud: {
        clientId: 'YOUR_CLIENT_ID',
        enabled: true
      }
    }
  }
}