export default {
  port: 2333,
  password: 'youshallnotpass',
  threshold: 2000,
  stateInterval: 5000,
  statsInterval: 5000,
  showReceivedRequestBody: true,
  sources: {
    youtube: true,
    spotify: true,
    deezer: true,
    soundcloud: {
      clientId: 'SOUND_CLOUD_CLIENT_ID',
      enabled: false
    }
  }
}