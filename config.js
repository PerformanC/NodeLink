export default {
  version: {
    major: '2',
    minor: '0',
    patch: '1',
    preRelease: ''
  },
  server: {
    port: 2333,
    password: 'youshallnotpass'
  },
  options: {
    threshold: false,
    playerUpdateInterval: false,
    statsInterval: false,
    maxResultsLength: 200,
    maxAlbumPlaylistLength: 200,
    maxCaptionsLength: 3,
    logFile: 'logs.txt'
  },
  debug: {
    youtube: {
      success: true,
      error: true
    },
    pandora: {
      success: true,
      error: true
    },
    deezer: {
      success: true,
      error: true
    },
    spotify: {
      success: true,
      error: true
    },
    soundcloud: {
      success: true,
      error: true
    },
    musixmatch: true,
    websocket: {
      connect: true,
      disconnect: true,
      resume: true,
      failedResume: true,
      resumeTimeout: true,
      error: true,
      connectCD: true,
      disconnectCD: true,
      sentDataCD: true
    },
    request: {
      all: false, // Only enable for debugging purposes.
      enabled: true,
      error: true,
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
      retrieveStream: true,
      loadtrack: {
        request: true,
        results: true,
        exception: true
      },
      search: {
        request: true,
        results: true,
        exception: true
      },
      loadlyrics: {
        request: true,
        results: true,
        exception: true
      }
    }
  },
  search: {
    defaultSearchSource: 'youtube',
    fallbackSearchSource: 'bandcamp',
    lyricsFallbackSource: 'genius',
    sources: {
      youtube: {
        enabled: true,
        authentication: {
          enabled: false, // Authentication using accounts outside EU helps bypass 403 errors. Enable at your own risk.
          cookies: { // Available in YouTube website cookies.
            SID: 'DISABLED',
            LOGIN_INFO: 'DISABLED'
          },
          authorization: 'DISABLED' // Available in YouTube website in Authorization header.
        },
        bypassAgeRestriction: false // Bypasses age-restricted videos. Enable at your own risk.
      },
      bandcamp: true,
      http: false, // Enabling can allow IP leaks. Enable at your own risk.
      local: false, // Enabling can allow access to local files. Enable at your own risk.
      pandora: false,
      spotify: {
        enabled: true,
        market: 'BR',
        sp_dc: 'DISABLED' // Necessary for direct Spotify loadLyrics. Available in Spotify website cookies in sp_dc parameter.
      },
      deezer: {
        enabled: false,
        decryptionKey: 'DISABLED', // For legal reasons, this key is not provided.
        arl: 'DISABLED' // Necessary for direct Deezer Lyrics. Available in Deezer website cookies in arl parameter.
      },
      soundcloud: {
        enabled: true,
        clientId: 'AUTOMATIC', // Available in SoundCloud website API requests in client_id parameter.
        fallbackIfSnipped: true
      },
      musixmatch: {
        enabled: false,
        signatureSecret: 'DISABLED' // For legal reasons, this key is not provided.
      },
      genius: {
        enabled: true
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
  },
  audio: {
    quality: 'high',
    encryption: 'xsalsa20_poly1305_lite'
  },
  voiceReceive: {
    type: 'pcm', // pcm, opus
    timeout: 1000 // 1s of silence to consider as it stopped speaking.
  }
}