export default {
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    threshold: 100000,
    stateInterval: 5000,
    statsInterval: 5000,
  },
  debug: {
    showReqBody: true,
    showResBody: true
  },
  search: {
    defautlSearchSource: 'soundcloud',
    sources: {
      youtube: true,
      spotify: true,
      deezer: true,
      soundcloud: {
        clientId: 'YOUR_CLIENT_ID',
        enabled: true
      }
    }
  }
}