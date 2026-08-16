export const config = {
    server: {
        host: '0.0.0.0',
        port: 3000,
        password: 'youshallnotpass',
        useBunServer: true
    },
    cluster: {
        enabled: true,
        workers: 0,
        minWorkers: 1,
        runtime: {
            workerMaxOldSpaceMb: 0,
            workerExposeGc: false,
            workerExecArgv: [],
            sourceWorkerMaxOldSpaceMb: 0,
            sourceWorkerExposeGc: false,
            sourceWorkerExecArgv: []
        },
        specializedSourceWorker: {
            enabled: true,
            count: 1,
            microWorkers: 2,
            tasksPerWorker: 32,
            silentLogs: true
        },
        timeouts: {
            heavyMs: 6000,
            fastMs: 4000
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
    rateLimit: {
        enabled: true,
        maxEntries: 10000,
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
    trustProxy: false,
    network: {
        proxy: {
            enabled: false,
            strategy: 'RoundRobin',
            retries: 3,
            timeout: 10000,
            shuffleOnStart: true,
            list: []
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
        routePlanner: {
            strategy: 'RotateOnBan',
            bannedIpCooldown: 600000,
            ipBlocks: []
        }
    },
    search: {
        maxResults: 10,
        defaultSource: ['youtube', 'soundcloud'],
        unifiedSources: ['youtube', 'soundcloud'],
        resolveExternalLinks: false,
        fetchChannelInfo: false
    },
    playback: {
        maxPlaylistLength: 100,
        playerUpdateInterval: 2000,
        statsUpdateInterval: 30000,
        trackStuckThresholdMs: 10000,
        eventTimeoutMs: 15000,
        zombieThresholdMs: 60000,
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
        audio: {
            quality: 'high',
            encryption: 'aead_xchacha20_poly1305_rtpsize',
            resamplingQuality: 'best',
            loudnessNormalizer: false,
            lookaheadMs: 5,
            gateThresholdLUFS: -60,
            fading: {
                enabled: false,
                trackStart: {
                    duration: 0,
                    curve: 'linear',
                    type: 'volume'
                },
                trackEnd: {
                    duration: 0,
                    curve: 'linear',
                    type: 'volume'
                },
                trackStop: {
                    duration: 0,
                    curve: 'linear',
                    type: 'volume'
                },
                seek: {
                    duration: 0,
                    curve: 'linear',
                    type: 'volume'
                },
                pause: {
                    duration: 0,
                    curve: 'sinusoidal',
                    type: 'tape'
                },
                resume: {
                    duration: 0,
                    curve: 'sinusoidal',
                    type: 'tape'
                },
                ducking: {
                    enabled: false,
                    duration: 0,
                    targetVolume: 0.3,
                    curve: 'linear'
                }
            },
            crossfade: {
                enabled: false,
                duration: 0,
                curve: 'sinusoidal',
                mode: 'preload',
                minBufferMs: 250,
                bufferMs: 0
            }
        },
        voiceReceive: {
            enabled: false,
            format: 'opus'
        },
        mix: {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5,
            autoCleanup: true
        }
    },
    api: {
        enableTrackStreamEndpoint: false,
        enableLoadStreamEndpoint: false,
        metrics: {
            enabled: true,
            authorization: {
                type: 'Bearer',
                username: 'admin',
                password: ''
            }
        }
    },
    experimental: {
        enableHoloTracks: false
    },
    sources: {
        youtube: {
            enabled: true,
            allowItag: [],
            targetItag: null,
            getOAuthToken: false,
            hl: 'en',
            gl: 'US',
            proxies: [],
            mirrorOfficialAlbums: false,
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
            ],
            clients: {
                search: ['Android'],
                playback: [
                    'VisionOs',
                    'AndroidVR',
                    'TV_DOWN',
                    'TV',
                    'TVCast',
                    'WebEmbedded',
                    'WebParentTools',
                    'Web',
                    'IOS'
                ],
                resolve: [
                    'VisionOs',
                    'AndroidVR',
                    'TV_DOWN',
                    'TV',
                    'TVCast',
                    'WebEmbedded',
                    'WebParentTools',
                    'IOS',
                    'Web'
                ],
                settings: {
                    TV: {
                        refreshToken: ['']
                    }
                }
            },
            cipher: {
                url: 'https://cipher.kikkia.dev/api',
                token: null
            }
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
            allowLocalFiles: false,
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
        vkmusic: {
            enabled: true,
            userToken: '',
            userCookie: '',
            proxy: {
                url: '',
                username: '',
                password: ''
            },
            network: {
                proxy: {
                    url: '',
                    username: '',
                    password: ''
                }
            }
        },
        deezer: {
            enabled: true,
            arl: '',
            decryptionKey: ''
        },
        tidal: {
            enabled: true,
            token: 'token_here',
            countryCode: 'US',
            playlistLoadLimit: 2,
            playlistPageLoadConcurrency: 5,
            hifiApis: [''],
            hifiQualities: ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW']
        },
        jiosaavn: {
            enabled: true,
            playlistLoadLimit: 50,
            artistLoadLimit: 20,
            proxy: {
                url: '',
                username: '',
                password: ''
            },
            network: {
                proxy: {
                    url: '',
                    username: '',
                    password: ''
                }
            },
            secretKey: '38346591'
        },
        gaana: {
            enabled: true,
            streamQuality: 'high',
            playlistLoadLimit: 100,
            albumLoadLimit: 100,
            artistLoadLimit: 100,
            proxy: {
                url: '',
                username: '',
                password: ''
            },
            network: {
                proxy: {
                    url: '',
                    username: '',
                    password: ''
                }
            }
        },
        yandexmusic: {
            enabled: true,
            accessToken: '',
            allowUnavailable: false,
            allowExplicit: true,
            artistLoadLimit: 1,
            albumLoadLimit: 1,
            playlistLoadLimit: 1,
            proxy: {
                url: '',
                username: '',
                password: ''
            },
            network: {
                proxy: {
                    url: '',
                    username: '',
                    password: ''
                }
            }
        },
        eternalbox: {
            enabled: true,
            baseUrl: 'https://eternalboxmirror.xyz',
            searchResults: 30,
            enrichSpotify: true,
            includeAnalysis: true,
            includeAnalysisSummary: true,
            eternalStream: true,
            cacheMaxBytes: 20971520,
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
        http: {
            enabled: true,
            userAgent: ''
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
        pipertts: {
            enabled: false,
            url: 'http://localhost:5000',
            voice: 'en_US-lessac-medium',
            speaker: 0,
            speaker_id: '',
            length_scale: 1.0,
            noise_scale: 0.667,
            noise_w_scale: 0.8
        },
        audius: {
            enabled: true,
            appName: '',
            apiKey: '',
            apiSecret: '',
            playlistLoadLimit: 100,
            albumLoadLimit: 100
        },
        qobuz: {
            enabled: true,
            userToken: '',
            formatId: '5',
            allowExplicit: true
        },
        monochrome: {
            enabled: false,
            instances: [],
            streamingInstances: [],
            quality: 'HI_RES_LOSSLESS',
            qobuzQuality: 6
        },
        pandora: {
            enabled: true,
            csrfToken: '',
            remoteTokenUrl: 'https://get.1lucas1apk.fun/pandora/gettoken'
        },
        amazonmusic: {
            enabled: true,
            playlistLoadLimit: 0,
            albumLoadLimit: 0
        },
        bluesky: {
            enabled: true,
            maxSearchResults: 10
        },
        anghami: {
            enabled: false,
            cookies: ''
        },
        rss: {
            enabled: true
        },
        mixcloud: {
            enabled: true
        },
        audiomack: {
            enabled: true
        },
        bandcamp: {
            enabled: true
        },
        newgrounds: {
            enabled: true
        },
        soundcloud: {
            enabled: true,
            clientId: ''
        },
        local: {
            enabled: true,
            basePath: './local-music/'
        },
        vimeo: {
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
            sessdata: '',
            network: {
                proxy: {
                    url: '',
                    username: '',
                    password: ''
                }
            }
        },
        genius: {
            enabled: true
        },
        pinterest: {
            enabled: true
        },
        'google-tts': {
            enabled: true,
            language: 'en-US'
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
        lastfm: {
            enabled: true,
            apiKey: ''
        },
        netease: {
            enabled: true
        },
        letrasmus: {
            enabled: true
        },
        googledrive: {
            enabled: true,
            cookies: ''
        },
        tiktok: {
            enabled: true
        }
    },
    lyrics: {
        fallbackSource: 'genius',
        preferredSources: [],
        youtube: {
            enabled: true
        },
        genius: {
            enabled: true
        },
        musixmatch: {
            enabled: true
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
    cache: {
        diskEnabled: true
    },
    plugins: [],
    pluginConfig: {}
};
export default config;
