export default {
  server: {
    host: '0.0.0.0',
    port: 3000,
    password: 'youshallnotpass',
    useBunServer: false // set to true to use Bun.serve websocket (experimental)
  },
  cluster: {
    enabled: true, // active cluster (or use env CLUSTER_ENABLED)
    workers: 0, // 0 => uses os.cpus().length, or specify a number (1 = 2 processes total: master + 1 worker)
    minWorkers: 1, // Minimum workers to keep alive (improves availability during bursts)
    runtime: {
      workerMaxOldSpaceMb: 0, // 0 disables override; set >0 to pass --max-old-space-size to playback workers
      workerExposeGc: false, // If true, adds --expose-gc to playback workers
      workerExecArgv: [], // Extra Node.js args for playback workers (e.g. ['--trace-gc'])
      sourceWorkerMaxOldSpaceMb: 0, // 0 disables override; set >0 to pass --max-old-space-size to source workers
      sourceWorkerExposeGc: false, // If true, adds --expose-gc to source workers
      sourceWorkerExecArgv: [] // Extra Node.js args for source workers
    },
    specializedSourceWorker: {
      enabled: true, // If true, source loading (search, lyrics, etc.) is delegated to dedicated workers to prevent voice worker lag
      count: 1, // Number of separate process clusters for source operations
      microWorkers: 2, // Number of worker threads per process cluster
      tasksPerWorker: 32, // Number of parallel tasks each micro-worker can handle before queuing
      silentLogs: true // If true, micro-workers will only log warnings and errors
    },
    commandTimeout: 6000, // Timeout for heavy operations like loadTracks (6s)
    fastCommandTimeout: 4000, // Timeout for player commands like play/pause (4s)
    maxRetries: 2, // Number of retry attempts on timeout or worker failure
    hibernation: {
      enabled: true,
      timeoutMs: 1200000
    },
    scaling: {
      //scaling configurations
      maxPlayersPerWorker: 20, // Reference capacity for utilization calculation
      targetUtilization: 0.7, // Target utilization for scaling up/down
      scaleUpThreshold: 0.75, // Utilization threshold to scale up
      scaleDownThreshold: 0.3, // Utilization threshold to scale down
      checkIntervalMs: 5000, // Interval to check for scaling needs
      idleWorkerTimeoutMs: 60000, // Time in ms an idle worker should wait before being removed
      queueLengthScaleUpFactor: 5, // How many commands in queue per active worker trigger scale up
      lagPenaltyLimit: 60, // Event loop lag threshold (ms) to penalize worker cost
      cpuPenaltyLimit: 0.85 // CPU usage threshold (85% of a core) to force scale up
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
    interval: 300000, // 5 minutes
    timeout: 10000, // 10 seconds
    thresholds: {
      bad: 1, // Mbps
      average: 5 // Mbps
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
  sponsorblock: {
    enabled: false,
    api: 'https://sponsor.ajay.app',
    categories: [
      'sponsor',
      'selfpromo',
      'interaction',
      'intro',
      'outro',
      'preview',
      'music_offtopic',
      'filler'
    ],
    actionTypes: ['skip'],
    skipMarginMs: 150
  },
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
      userCookie: '', // (required without userToken) get from vk in browser devtools -> reqs POST /?act=web_token HTTP/2 - headers -> request -> cookie (copy full cookie header)
      proxy: {
        url: '',
        username: '',
        password: ''
      }
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
      // arl: '',
      // decryptionKey: '',
      enabled: true
    },
    bandcamp: {
      enabled: true
    },
    soundcloud: {
      enabled: true
      // clientId: ""
    },
    local: {
      enabled: true,
      basePath: './local-music/'
    },
    http: {
      enabled: true,
      userAgent: '' // Optional: defaults to NodeLink/<version> (https://github.com/PerformanC/NodeLink)
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
      // Note: not 100% of the songs are currently working (but most should.), because i need to code a different extractor for every year (2010, 2011, etc. not all are done)
      enabled: true
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
      sessdata: '' // Optional, improves access to some videos (premium and 4k+)
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
    lazypytts: {
      enabled: true,
      service: 'Cerence',
      voice: 'Luciana',
      maxTextLength: 3000,
      enforceConfig: false
    },
    jiosaavn: {
      enabled: true,
      playlistLoadLimit: 50,
      artistLoadLimit: 20,
      proxy: {
        url: '',
        username: '',
        password: ''
      }
      // "secretKey": "38346591" // Optional, defaults to standard key
    },
    gaana: {
      enabled: true,
      streamQuality: 'high',
      playlistLoadLimit: 100,
      albumLoadLimit: 100,
      artistLoadLimit: 100,
      proxy: {
        url: '', // The HTTP/HTTPS proxy to use
        username: '', // Optional username
        password: '' // Optional password
      }
    },
    'google-tts': {
      enabled: true,
      language: 'en-US'
    },
    // Piper TTS Configuration
    // This source uses an external Piper TTS HTTP server.
    // You can find the Piper HTTP server repository here:
    // https://github.com/OHF-Voice/piper1-gpl/tree/main?tab=readme-ov-file
    pipertts: {
      enabled: false, // Disabled by default. Enable it to use Piper TTS.
      url: 'http://localhost:5000' // URL of your Piper TTS server
      // Optional settings (defaults from Piper):
      // voice: 'en_US-lessac-medium',
      // speaker: 0,
      // length_scale: 1.0,
      // noise_scale: 0.667,
      // noise_w_scale: 0.8
    },
    youtube: {
      enabled: true,
      allowItag: [], // additional itags for audio streams, e.g., [140, 141]
      targetItag: null, // force a specific itag for audio streams, overriding the quality option
      getOAuthToken: false,
      hl: 'en',
      gl: 'US',
      proxies: [
        /* {
          url: "http://proxy1:port",
          username: "username",
          password: "password"
        },
        {
          url: "http://proxy2:port"
        } */
      ],
      fallbackSources: [
        'soundcloud',
        'deezer',
        'jiosaavn',
        'qobuz',
        'gaana',
        'vkmusic',
        'yandexmusic',
        'audiomack',
        'bandcamp',
        'audius',
        'mixcloud',
        'bilibili',
        'bluesky',
        'nicovideo'
      ], // Internal fallback chain when YouTube stream URL fails
      clients: {
        search: ['Android'], // Clients used for searching tracks
        playback: [
          'AndroidVR',
          'TV',
          'TVCast',
          'WebEmbedded',
          'WebParentTools',
          'Web',
          'IOS'
        ], // Clients used for playback/streaming
        resolve: [
          'AndroidVR',
          'TV',
          'TVCast',
          'WebEmbedded',
          'WebParentTools',
          'IOS',
          'Web'
        ], // Clients used for resolving detailed track information (channel, external links, etc.)
        settings: {
          TV: {
            refreshToken: [''] // You can use a string "token" or an array ["token1", "token2"] for rotation/fallback
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
      externalAuthUrl: 'http://get.1lucas1apk.fun/spotify/gettoken', // URL to external token provider (e.g. http://localhost:8080/api/token - use https://github.com/topi314/spotify-tokener or https://github.com/1Lucas1apk/gettoken)
      market: 'US',
      playlistLoadLimit: 1, // 0 means no limit (loads all tracks), 1 = 100 tracks, 2 = 100 and so on!
      playlistPageLoadConcurrency: 10, // How many pages to load simultaneously
      albumLoadLimit: 1, // 0 means no limit (loads all tracks), 1 = 50 tracks, 2 = 100 tracks, etc.
      albumPageLoadConcurrency: 5, // How many pages to load simultaneously
      allowExplicit: true, // If true plays the explicit version of the song, If false plays the Non-Explicit version of the song. Normal songs are not affected.
      allowLocalFiles: false, // If true, Spotify playlist local files are kept as placeholder tracks so they can still be searched and played through fallback sources.
      sp_dc: '' // fot getting mobile token (optional) get from spotify in browser devtools -> Application -> Cookies -> sp_dc (required for canvas)
    },
    applemusic: {
      enabled: true,
      mediaApiToken: 'token_here', //manually | or "token_here" to get a token automatically
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
      token: 'token_here', //manually | or "token_here" to get a token automatically, get from tidal web player devtools; using login google account
      countryCode: 'US',
      playlistLoadLimit: 2, // 0 = no limit, 1 = 50 tracks, 2 = 100 tracks, etc.
      playlistPageLoadConcurrency: 5, // How many pages to load simultaneously
      hifiApis: [''], // optional, but required for direflct streaming, artist resolving host: https://github.com/binimum/hifi-api/
      hifiQualities: ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'] //tried sequentially until one works (only used if hifiApis is set)
    },
    pandora: {
      enabled: true,
      // Optional, setting this manually can help unblocking countries (since pandora is US only.). May need to be updated periodically.
      // fetching manually: use a vpn connected to US, go on pandora.com, open devtools, Network tab, first request to appear and copy the 2nd csrfToken= value.
      // csrfToken: '',
      remoteTokenUrl: 'https://get.1lucas1apk.fun/pandora/gettoken' // URL to a remote provider that returns { success: true, authToken: "...", csrfToken: "...", expires_in_seconds: ... } //https://github.com/1Lucas1apk/gettoken
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
      userToken: '', // (optional) get from play.qobuz.com in browser devtools -> Application -> Local Storage -> localuser -> token
      formatId: '5', // 5 = MP3 320kbps, 6 = FLAC (requires Studio subscription), 27 = Hi-Res FLAC
      allowExplicit: true
    },
    lastfm: {
      enabled: true,
      apiKey: '' // You can get the api key from: https://www.last.fm/api/account/create
    },
    netease: {
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
      artistLoadLimit: 1, // 0 = no limit, 1 = 10 tracks, 2 = 20 tracks, etc.
      albumLoadLimit: 1, // 0 = no limit, 1 = 50 tracks, 2 = 100 tracks, etc.
      playlistLoadLimit: 1, // 0 = no limit, 1 = 100 tracks, 2 = 200 tracks, etc.
      proxy: {
        url: '',
        username: '',
        password: ''
      }
    },
    monochrome: {
      enabled: true,
      instances: [], // (optional) list of API instances
      streamingInstances: [], // (optional) list of streaming instances
      quality: 'HI_RES_LOSSLESS' // HI_RES_LOSSLESS, LOSSLESS, HIGH, LOW
    },
    googledrive: {
      enabled: true
    },
    tiktok: {
      enabled: true
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
      enabled: true
      // signatureSecret: ''
    },
    deezer: {
      enabled: true
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
    },
    monochrome: {
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
    quality: 'high', // high, medium, low, lowest
    encryption: 'aead_xchacha20_poly1305_rtpsize', // aead_aes256_gcm_rtpsize or aead_xchacha20_poly1305_rtpsize
    resamplingQuality: 'best', // best, medium, fastest, zero order holder, linear
    loudnessNormalizer: false, // Enable/disable AGC globally
    lookaheadMs: 5, // Limiter lookahead buffer in milliseconds
    gateThresholdLUFS: -60, // Silence threshold for AGC gate
    fading: {
      enabled: false, // Master switch for all fades
      // type meanings:
      // volume = only amplitude fades, tape = pitch/speed ramps, both = simultaneous fade and ramp, scratch = physical vinyl simulation
      // curve meanings:
      // linear = constant rate, exponential = slow start then faster, sinusoidal = smooth s-curve, start/wash/stop/random/baby = scratch specific movements
      trackStart: {
        // Effect when a new track begins
        duration: 0, // ms
        curve: 'linear',
        type: 'volume' // volume, tape, both
      },
      trackEnd: {
        // Effect triggered automatically before track finishes
        duration: 0,
        curve: 'linear',
        type: 'volume'
      },
      trackStop: {
        // Effect when manually stopping or skipping
        duration: 0,
        curve: 'linear',
        type: 'volume'
      },
      seek: {
        // Effect applied after a seek operation
        duration: 0,
        curve: 'linear',
        type: 'volume'
      },
      pause: {
        // Effect applied when pausing playback
        duration: 0,
        curve: 'sinusoidal',
        type: 'tape'
      },
      resume: {
        // Effect applied when resuming from pause
        duration: 0,
        curve: 'sinusoidal',
        type: 'tape'
      },
      ducking: {
        // Partial fade out for overlay events (e.g., TTS, notifications)
        enabled: false,
        duration: 0, // ms
        targetVolume: 0.3, // Volume multiplier (0.3 = 30%)
        curve: 'linear'
      }
    },
    crossfade: {
      enabled: false,
      duration: 0, // Crossfade duration in milliseconds
      curve: 'sinusoidal', // linear | sine | sinusoidal
      mode: 'preload', // preload or stream
      minBufferMs: 250, // Minimum buffered PCM before crossfade starts
      bufferMs: 0 // 0 = auto (use duration)
    }
  },
  voiceReceive: {
    enabled: false,
    format: 'opus' // pcm_s16le, opus
  },
  routePlanner: {
    strategy: 'RotateOnBan', // RotateOnBan, RoundRobin, LoadBalance
    bannedIpCooldown: 600000, // 10 minutes
    ipBlocks: []
  },
  rateLimit: {
    enabled: true,
    global: {
      maxRequests: 1000,
      timeWindowMs: 60000 // 1 minute
    },
    perIp: {
      maxRequests: 100,
      timeWindowMs: 10000 // 10 seconds
    },
    perUserId: {
      maxRequests: 50,
      timeWindowMs: 5000 // 5 seconds
    },
    perGuildId: {
      maxRequests: 20,
      timeWindowMs: 5000 // 5 seconds
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
      timeWindowMs: 10000 // 10 seconds
    },
    mitigation: {
      delayMs: 500,
      blockDurationMs: 300000 // 5 minutes
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
      type: 'Bearer', // Bearer or Basic.
      username: 'admin',
      password: '' // If empty, uses server.password
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
