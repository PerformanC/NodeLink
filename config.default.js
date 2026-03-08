export default {
  server: {
    host: '0.0.0.0',
    port: 3000,
    password: '123456',
    useBunServer: false
  },
  cluster: {
    enabled: true,
    workers: 0,
    minWorkers: 1, 
    specializedSourceWorker: {
      enabled: true, 
      count: 1,
      microWorkers: 2, 
      tasksPerWorker: 32,
      silentLogs: true 
    },
    commandTimeout: 6000,
    fastCommandTimeout: 4000, 
    maxRetries: 2, 
    hibernation: {
      enabled: true,
      timeoutMs: 1200000
    },
    scaling: {
      maxPlayersPerWorker: 20,
      targetUtilization: 0.7,
      scaleUpThreshold: 0.75,
      scaleDownThreshold: 0.3,
      checkIntervalMs: 5000,
      idleWorkerTimeoutMs: 60000,
      queueLengthScaleUpFactor: 5, 
      lagPenaltyLimit: 60,
      cpuPenaltyLimit: 0.85 
    },
    endpoint: {
      patchEnabled: true,
      allowExternalPatch: false,
      code: 'CAPYBARA'
    }
  },
  logging: {
    level: 'debug',
    file: {
      enabled: false,
      path: 'logs',
      rotation: 'daily',
      ttlDays: 7
    },
    debug: {
      all: false,
      request: true,
      session: true,
      player: true,
      filters: true,
      sources: true,
      lyrics: true,
      youtube: true,
      'youtube-cipher': true,
      sabr: false,
      potoken: false
    }
  },
  connection: {
    logAllChecks: false,
    interval: 300000, 
    timeout: 10000,
    thresholds: {
      bad: 1,
      average: 5
    }
  },
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  playerUpdateInterval: 2000,
  statsUpdateInterval: 30000,
  trackStuckThresholdMs: 10000,
  eventTimeoutMs: 15000,
  zombieThresholdMs: 60000,
  enableHoloTracks: false,
  enableTrackStreamEndpoint: false,
  enableLoadStreamEndpoint: false,
  resolveExternalLinks: false,
  fetchChannelInfo: false,
  filters: {
    enabled: {
      tremolo: true,
      vibrato: true,
      lowpass: true,
      highpass: true,
      rotation: true,
      karaoke: true,
      distortion: true,
      channelMix: true,
      equalizer: true,
      chorus: true,
      compressor: true,
      echo: true,
      phaser: true,
      timescale: true
    }
  },
  defaultSearchSource: ['youtube', 'soundcloud'],
  unifiedSearchSources: ['youtube', 'soundcloud'],
  sources: {
    vkmusic: {
      enabled: true,
      userToken: '', // (optional) get from vk in browser devtools -> reqs POST /?act=web_token HTTP/2 - headers -> response -> access_token
      userCookie: '' // (required without userToken) get from vk in browser devtools -> reqs POST /?act=web_token HTTP/2 - headers -> request -> cookie (copy full cookie header)
    },
    amazonmusic: {
      enabled: true
    },
    bluesky: {
      enabled: true
    },
    anghami: {
      enabled: false,
      cookies: '' // Optional: Useful for accessing restricted or private content
    },
    rss: {
      enabled: true
    },
    songlink: {
      enabled: true,
      apiKey: '',
      userCountry: 'US',
      songIfSingle: true,
      useApi: true,
      useScrapeFallback: true,
      preferredPlatforms: [
        'spotify',
        'appleMusic',
        'youtubeMusic',
        'youtube',
        'deezer',
        'tidal',
        'amazonMusic',
        'soundcloud',
        'bandcamp',
        'audius',
        'audiomack',
        'pandora',
        'itunes',
        'amazonStore'
      ],
      fallbackToAny: true
    },
    mixcloud: {
      enabled: true
    },
    audiomack: {
      enabled: true
    },
    deezer: {
      arl: '',
      decryptionKey: '',
      enabled: true
    },
    bandcamp: {
      enabled: true
    },
    soundcloud: {
      enabled: true,
      clientId: ""
    },
    local: {
      enabled: true,
      basePath: './local-music/'
    },
    http: {
      enabled: true
    },
    eternalbox: {
      enabled: true,
      baseUrl: 'https://eternalboxmirror.xyz',
      searchResults: 30,
      enrichSpotify: true,
      includeAnalysis: true,
      includeAnalysisSummary: true,
      eternalStream: true,
      cacheMaxBytes: 20 * 1024 * 1024,
      maxBranches: 4,
      maxBranchThreshold: 75,
      branchThresholdStart: 10,
      branchThresholdStep: 5,
      branchTargetDivisor: 6,
      addLastEdge: true,
      justBackwards: false,
      justLongBranches: false,
      removeSequentialBranches: true,
      useFilteredSegments: true,
      minRandomBranchChance: 0.18,
      maxRandomBranchChance: 0.5,
      randomBranchChanceDelta: 0.09,
      timbreWeight: 1,
      pitchWeight: 10,
      loudStartWeight: 1,
      loudMaxWeight: 1,
      durationWeight: 100,
      confidenceWeight: 1,
      infiniteStream: true,
      maxReconnects: 0,
      reconnectDelayMs: 1000
    },
    vimeo: {
      enabled: true,
    },
    iheartradio: {
      enabled: true
    },
    telegram: {
      enabled: true
    },
    shazam: {
      enabled: true,
      allowExplicit: true
    },
    bilibili: {
      enabled: true,
      sessdata: ''
    },
    genius: {
      enabled: true
    },
    pinterest: {
      enabled: true
    },
    flowery: {
      enabled: true,
      voice: 'Salli',
      translate: false,
      silence: 0,
      speed: 1.0,
      enforceConfig: false
    },
    jiosaavn: {
      enabled: true,
      playlistLoadLimit: 50,
      artistLoadLimit: 20,
      "secretKey": "38346591"
    },
    gaana: {
      enabled: true,
      apiUrl: 'https://gaana.1lucas1apk.fun/api',
      streamQuality: 'high',
      playlistLoadLimit: 100,
      albumLoadLimit: 100,
      artistLoadLimit: 100
    },
    "google-tts": {
      enabled: true,
      language: 'en-US'
    },
   
    pipertts: {
      enabled: false, 
      url: 'http://localhost:5000', 
      voice: 'en_US-lessac-medium',
      speaker: 0,
      length_scale: 1.0,
      noise_scale: 0.667,
      noise_w_scale: 0.8
    },
    youtube: {
      enabled: true,
      allowItag: [], 
      targetItag: null, 
      getOAuthToken: false,
      hl: 'en',
      gl: 'US',
      clients: {
        search: ['Android'], 
        playback: ['AndroidVR', 'TV', 'WebEmbedded', 'WebParentTools', 'Web', 'IOS'], 
        resolve: ['AndroidVR', 'TV', 'WebEmbedded', 'WebParentTools', 'IOS', 'Web'], 
        settings: {
          TV: {
            refreshToken: [""] 
          }
        }
      },
      cipher: {
        url: 'https://cipher.kikkia.dev/api',
        token: null
      }
    },
    instagram: {
      enabled: true
    },
    kwai: {
      enabled: true
    },
    twitch: {
      enabled: true
    },
    spotify: {
      enabled: true,
      clientId: '',
      clientSecret: '',
      externalAuthUrl: 'http://get.1lucas1apk.fun/spotify/gettoken',
      market: 'US',
      playlistLoadLimit: 1, 
      playlistPageLoadConcurrency: 10, 
      albumLoadLimit: 1, 
      albumPageLoadConcurrency: 5, 
      allowExplicit: true, 
      sp_dc: ''
    },
    applemusic: {
      enabled: true,
      mediaApiToken: 'token_here',
      market: 'US',
      playlistLoadLimit: 0,
      albumLoadLimit: 0,
      playlistPageLoadConcurrency: 5,
      albumPageLoadConcurrency: 5,
      allowExplicit: true
    },
    audius: {
      enabled: true,
      appName: '',
      apiKey: '', // go to https://audius.co/settings and create an app and paste the app name and api stuff into here.
      apiSecret: '',
      playlistLoadLimit: 100,
      albumLoadLimit: 100
    },
    tidal: {
      enabled: true,
      token: 'token_here', 
      countryCode: 'US',
      playlistLoadLimit: 2,
      playlistPageLoadConcurrency: 5
    },
    pandora: {
      enabled: true,
      csrfToken: '',
      remoteTokenUrl: 'https://get.1lucas1apk.fun/pandora/gettoken'
    },
    nicovideo: {
      enabled: true
    },
    reddit: {
      enabled: true
    },
    tumblr: {
      enabled: true
    },
    twitter: {
      enabled: true
    },
    qobuz: {
      enabled: true,
      userToken: '', 
      formatId: '5',
      allowExplicit: true
    },
    lastfm: {
      enabled: true
    },
    letrasmus: {
      enabled: true
    },
    yandexmusic: {
      enabled: true,
      accessToken: '',
      allowUnavailable: false,
      allowExplicit: true,
      artistLoadLimit: 1, 
      albumLoadLimit: 1,
      playlistLoadLimit: 1
    }
  },
  lyrics: {
    fallbackSource: 'genius',
    youtube: {
      enabled: true
    },
    genius: {
      enabled: true
    },
    musixmatch: {
      enabled: true,
      signatureSecret: ''
    },
    lrclib: {
      enabled: true
    },
    letrasmus: {
      enabled: true
    },
    bilibili: {
      enabled: true
    },
    yandexmusic: {
      enabled: true
    }
  },
  meanings: {
    letrasmus: {
      enabled: true
    },
    wikipedia: {
      enabled: true
    }
  },
  audio: {
    quality: 'high',
    encryption: 'aead_aes256_gcm_rtpsize',
    resamplingQuality: 'best', 
    fading: {
      enabled: false,
      trackStart: {
        duration: 0,
        curve: 'linear'
      },
      trackEnd: {
        duration: 0,
        curve: 'linear'
      },
      trackStop: {
        duration: 0,
        curve: 'linear'
      },
      seek: {
        duration: 0,
        curve: 'linear'
      },
      ducking: {
        enabled: false,
        duration: 0,
        targetVolume: 0.3,
        curve: 'linear'
      }
    }
  },
  voiceReceive: {
    enabled: false,
    format: 'opus' 
  },
  routePlanner: {
    strategy: 'RotateOnBan',
    bannedIpCooldown: 600000, 
    ipBlocks: []
  },
  rateLimit: {
    enabled: true,
    global: {
      maxRequests: 1000,
      timeWindowMs: 60000
    },
    perIp: {
      maxRequests: 100,
      timeWindowMs: 10000 
    },
    perUserId: {
      maxRequests: 50,
      timeWindowMs: 5000
    },
    perGuildId: {
      maxRequests: 20,
      timeWindowMs: 5000
    },
    ignorePaths: [],
    ignore: {
      userIds: [],
      guildIds: [],
      ips: []
    }
  },
  dosProtection: {
    enabled: true,
    thresholds: {
      burstRequests: 50,
      timeWindowMs: 10000 
    },
    mitigation: {
      delayMs: 500,
      blockDurationMs: 300000 
    },
    ignore: {
      userIds: [],
      guildIds: [],
      ips: []
    }
  },
  metrics: {
    enabled: true,
    authorization: {
      type: 'Bearer', 
      username: 'admin',
      password: ''
    }
  },
  mix: {
    enabled: true,
    defaultVolume: 0.8,
    maxLayersMix: 5,
    autoCleanup: true
  },
  plugins: [
    /*  {
          name: 'nodelink-sample-plugin',
          source: 'local'
        } */
  ],
  pluginConfig: {}
}
