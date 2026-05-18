import { logger } from "../utils.js";
import { validator } from "../validators.js";
/**
 * Validates the NodeLink configuration object using a schema-based approach.
 * Supports the new hierarchical configuration structure.
 */
export default class ConfigValidationManager {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Performs a full validation of the configuration.
     * @throws Error if validation fails.
     */
    validate() {
        const schema = {
            server: {
                type: 'object',
                props: {
                    host: { type: 'string', default: '0.0.0.0' },
                    port: {
                        type: 'number',
                        integer: true,
                        min: 1,
                        max: 65535,
                        default: 3000
                    },
                    engine: {
                        type: 'string',
                        enum: ['default', 'bun'],
                        default: 'default',
                        optional: true
                    },
                    password: { type: 'string', min: 1, optional: true },
                    useBunServer: { type: 'boolean', default: false, optional: true }
                }
            },
            cluster: {
                type: 'object',
                props: {
                    enabled: { type: 'boolean', default: true },
                    workers: { type: 'number', integer: true, min: 0 },
                    minWorkers: { type: 'number', integer: true, min: 0, default: 1 },
                    timeouts: {
                        type: 'object',
                        optional: true,
                        props: {
                            heavyMs: {
                                type: 'number',
                                integer: true,
                                min: 100,
                                default: 6000
                            },
                            fastMs: { type: 'number', integer: true, min: 100, default: 4000 }
                        }
                    }
                }
            },
            logging: {
                type: 'object',
                props: {
                    level: { type: 'string', default: 'info' },
                    file: {
                        type: 'object',
                        props: {
                            enabled: { type: 'boolean', default: false },
                            path: { type: 'string', default: 'logs' }
                        }
                    }
                }
            },
            connection: {
                type: 'object',
                props: {
                    interval: { type: 'number', integer: true, min: 1000 },
                    timeout: { type: 'number', integer: true, min: 1000 }
                }
            },
            rateLimit: {
                type: 'object',
                props: {
                    enabled: { type: 'boolean', default: true },
                    global: { type: 'object' },
                    perIp: { type: 'object' }
                }
            },
            dosProtection: {
                type: 'object',
                props: {
                    enabled: { type: 'boolean', default: true },
                    thresholds: { type: 'object' },
                    mitigation: { type: 'object' }
                }
            },
            trustProxy: { type: 'boolean', default: false },
            network: {
                type: 'object',
                props: {
                    proxy: {
                        type: 'object',
                        props: {
                            enabled: { type: 'boolean', default: false },
                            strategy: {
                                type: 'string',
                                enum: [
                                    'RoundRobin',
                                    'LeastConnections',
                                    'LowestLatency',
                                    'WeightedHealth'
                                ]
                            }
                        }
                    },
                    connection: {
                        type: 'object',
                        props: {
                            interval: { type: 'number', integer: true, min: 1000 },
                            timeout: { type: 'number', integer: true, min: 1000 }
                        }
                    }
                }
            },
            search: {
                type: 'object',
                props: {
                    maxResults: {
                        type: 'number',
                        integer: true,
                        min: 1,
                        max: 100,
                        default: 10
                    },
                    defaultSource: {
                        type: 'multi',
                        rules: [{ type: 'array', items: 'string' }, { type: 'string' }]
                    },
                    unifiedSources: { type: 'array', items: 'string', optional: true },
                    resolveExternalLinks: { type: 'boolean', default: false },
                    fetchChannelInfo: { type: 'boolean', default: false }
                }
            },
            playback: {
                type: 'object',
                props: {
                    maxPlaylistLength: {
                        type: 'number',
                        integer: true,
                        min: 0,
                        default: 100
                    },
                    playerUpdateInterval: {
                        type: 'number',
                        integer: true,
                        min: 100,
                        default: 2000,
                        optional: true
                    },
                    statsUpdateInterval: {
                        type: 'number',
                        integer: true,
                        min: 100,
                        default: 30000,
                        optional: true
                    },
                    trackStuckThresholdMs: {
                        type: 'number',
                        integer: true,
                        min: 100,
                        default: 10000,
                        optional: true
                    },
                    eventTimeoutMs: {
                        type: 'number',
                        integer: true,
                        min: 100,
                        default: 3000,
                        optional: true
                    },
                    zombieThresholdMs: {
                        type: 'number',
                        integer: true,
                        min: 100,
                        default: 300000,
                        optional: true
                    },
                    sponsorblock: {
                        type: 'object',
                        optional: true,
                        props: {
                            enabled: { type: 'boolean', default: false },
                            api: { type: 'string', optional: true },
                            categories: { type: 'array', items: 'string', optional: true },
                            actionTypes: { type: 'array', items: 'string', optional: true }
                        }
                    },
                    filters: { type: 'object', optional: true },
                    audio: {
                        type: 'object',
                        optional: true,
                        props: {
                            quality: {
                                type: 'string',
                                enum: ['high', 'medium', 'low', 'lowest']
                            },
                            encryption: { type: 'string', optional: true },
                            resamplingQuality: { type: 'string', optional: true },
                            loudnessNormalizer: { type: 'boolean', optional: true },
                            fading: { type: 'object', optional: true },
                            crossfade: { type: 'object', optional: true }
                        }
                    },
                    voiceReceive: { type: 'object', optional: true },
                    mix: { type: 'object', optional: true }
                }
            },
            api: {
                type: 'object',
                props: {
                    enableTrackStreamEndpoint: { type: 'boolean', default: false },
                    enableLoadStreamEndpoint: { type: 'boolean', default: false },
                    metrics: { type: 'object', optional: true }
                }
            },
            experimental: {
                type: 'object',
                props: {
                    enableHoloTracks: { type: 'boolean', default: false }
                }
            },
            sources: { type: 'object' },
            lyrics: { type: 'object' },
            meanings: { type: 'object' },
            metrics: { type: 'object' },
            mix: { type: 'object' },
            plugins: { type: 'array', items: 'object', optional: true },
            pluginConfig: { type: 'object', optional: true }
        };
        const check = validator.compile(schema);
        const result = check(this.config);
        if (result !== true) {
            const errors = Array.isArray(result) ? result : [];
            for (const error of errors) {
                logger('error', 'Config', `Validation error at ${error.field}: ${error.message}`);
            }
            throw new Error(`Configuration validation failed: ${errors.map((e) => e.message).join(', ')}`);
        }
        logger('info', 'Config', 'Configuration validated successfully.');
    }
}
