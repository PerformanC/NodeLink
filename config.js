/*
Any of the settings below can be disabled by setting them to false.

opt: 1 = Performance, 2 = Quality
threshold: 5000 = 5 seconds
playerUpdateInterval: 5000 = 5 seconds
statsInterval: 5000 = 5 seconds
autoUpdate: [ autoUpdate, interval, [tar, zip] ]
*/

export default {
  version: '1.6.3',
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    opt: 2,
    threshold: 10000,
    playerUpdateInterval: false,
    statsInterval: false,
    autoUpdate: [ true, 360000, 'tar' ],
    maxResults: 20,
    maxPlaylistSize: 20
  },
  debug: {
    pandoraInterval: true,
    innertube: true,
    websocket: {
      connected: true,
      disconnected: true,
      resume: true,
      failedResume: true
    },
    request: {
      enabled: true,
      showBody: true,
      showHeaders: true,
      showParams: true
    },
    track: {
      start: true,
      end: true,
      exception: true,
      stuck: true
    },
    sources: {
      loadtrack: {
        requested: true,
        results: true,
        exceptions: true
      },
      search: {
        requested: true,
        results: true,
        exceptions: true
      }
    }
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
        enabled: false,
        clientId: 'YOUR_CLIENT_ID'
      }
    }
  },
  filters: {
    enabled: true,
    threads: 4,
    list: {
      volume: true,
      equalizer: true,
      karaoke: true,
      timescale: true,
      tremolo: true,
      vibrato: true,
      rotation: true,
      distortion: true,
      channelMix: true,
      lowPass: true
    }
  }
}