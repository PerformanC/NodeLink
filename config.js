export default {
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    threshold: 5000,
    playerUpdateInterval: 5000,
    statsInterval: 5000,
    maxResults: 10,
  },
  debug: {
    showReqBody: true
  },
  search: {
    defaultSearchSource: 'youtube',
    sources: {
      youtube: true,
      spotify: true,
      deezer: true,
      bandcamp: true,
      http: true,
      local: true,
      soundcloud: {
        clientId: 'YOUR_CLIENT_ID',
        enabled: true
      }
    }
  }
}