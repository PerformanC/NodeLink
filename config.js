/*
Any of the settings below can be disabled by setting them to false.

threshold: 5000 = 5 seconds
playerUpdateInterval: 5000 = 5 seconds
statsInterval: 5000 = 5 seconds
autoUpdate: [ beta? autoUpdate?, interval, [tar, zip] ]
*/

export default {
  version: {
    major: '1',
    minor: '9',
    patch: '6',
    preRelease: null
  },
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    threshold: false,
    playerUpdateInterval: false,
    statsInterval: false,
    autoUpdate: [ false, true, 3600000, 'tar' ],
    maxResults: 20,
    maxPlaylistSize: 20
  },
  debug: {
    pandoraInterval: true,
    innertube: true,
    websocket: {
      connect: true,
      disconnect: true,
      resume: true,
      failedResume: true
    },
    request: {
      enabled: true,
      errors: true,
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
        request: true,
        results: true,
        exception: true
      },
      search: {
        request: true,
        results: true,
        exception: true
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
      pandora: false,
      soundcloud: {
        enabled: true,
        clientId: 'TihN0nuDfhghD9GVPbTtrSEa558lYo4V'
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