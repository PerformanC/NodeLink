export default {
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    // Performance: 1, Quality: 2
    opt: 2,
    threshold: 5000,
    playerUpdateInterval: 5000,
    statsInterval: 5000,
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