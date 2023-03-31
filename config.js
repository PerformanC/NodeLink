export default {
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    threshold: 100000,
    playerUpdateInterval: 5000,
    statsInterval: 5000,
    maxResults: 10,
  },
  debug: {
    showReqBody: true,
    showResBody: true
  },
  search: {
    defaultSearchSource: 'youtube',
    sources: {
      youtube: true,
      spotify: true,
      deezer: true,
      bandcamp: true,
      soundcloud: {
        clientId: 'YOUR_CLIENT_ID',
        enabled: true
      }
    }
  }
}