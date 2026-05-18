import { validator } from "../validators.js";
import { logger } from "../utils.js";
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
                    port: { type: 'number', integer: true, min: 1, max: 65535, default: 3000 },
                    engine: { type: 'string', enum: ['default', 'bun'], default: 'default' }
                }
            },
            security: {
                type: 'object',
                props: {
                    password: { type: 'string', min: 1 },
                    trustProxy: { type: 'boolean', default: false },
                    dosProtection: {
                        type: 'object',
                        props: {
                            enabled: { type: 'boolean', default: true },
                            thresholds: { type: 'object' },
                            mitigation: { type: 'object' }
                        }
                    },
                    rateLimit: {
                        type: 'object',
                        props: {
                            enabled: { type: 'boolean', default: true },
                            global: { type: 'object' },
                            perIp: { type: 'object' }
                        }
                    }
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
                        props: {
                            heavyMs: { type: 'number', integer: true, min: 100, default: 6000 },
                            fastMs: { type: 'number', integer: true, min: 100, default: 4000 }
                        }
                    }
                }
            },
            network: {
                type: 'object',
                props: {
                    proxy: {
                        type: 'object',
                        props: {
                            enabled: { type: 'boolean', default: false },
                            strategy: { type: 'string', enum: ['RoundRobin', 'LeastConnections', 'LowestLatency', 'WeightedHealth'] }
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
                    maxResults: { type: 'number', integer: true, min: 1, max: 100, default: 10 },
                    defaultSource: { type: 'array', items: 'string' }
                }
            },
            playback: {
                type: 'object',
                props: {
                    maxPlaylistLength: { type: 'number', integer: true, min: 0, default: 100 },
                    intervals: {
                        type: 'object',
                        props: {
                            playerUpdateMs: { type: 'number', integer: true, min: 100, default: 2000 },
                            statsUpdateMs: { type: 'number', integer: true, min: 100, default: 30000 }
                        }
                    },
                    audio: {
                        type: 'object',
                        props: {
                            quality: { type: 'string', enum: ['high', 'medium', 'low', 'lowest'] },
                            encryption: { type: 'string' }
                        }
                    }
                }
            }
        };
        const check = validator.compile(schema);
        const result = check(this.config);
        if (result !== true) {
            const errors = Array.isArray(result) ? result : [];
            for (const error of errors) {
                logger('error', 'Config', `Validation error at ${error.field}: ${error.message}`);
            }
            throw new Error(`Configuration validation failed: ${errors.map(e => e.message).join(', ')}`);
        }
        logger('info', 'Config', 'Configuration validated successfully.');
    }
}
