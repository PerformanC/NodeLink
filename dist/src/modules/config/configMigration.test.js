import assert from 'node:assert/strict';
import test from 'node:test';
import defaultConfig from '../../../config.default.js';
import { migrateConfig, toTsLiteral } from './configMigration.js';
test('migrateConfig maps legacy flat config to hierarchical structure', () => {
    const legacy = {
        server: {
            host: '0.0.0.0',
            port: 3000,
            password: 'legacy-pass',
            useBunServer: false
        },
        connection: {
            interval: 12345,
            timeout: 6789,
            thresholds: { bad: 1, average: 5 },
            logAllChecks: true
        },
        routePlanner: {
            strategy: 'RotateOnBan',
            bannedIpCooldown: 1000,
            ipBlocks: ['1.1.1.0/24']
        },
        maxSearchResults: 25,
        defaultSearchSource: ['youtube'],
        unifiedSearchSources: ['youtube', 'soundcloud'],
        resolveExternalLinks: true,
        fetchChannelInfo: true,
        maxAlbumPlaylistLength: 777,
        playerUpdateInterval: 3000,
        statsUpdateInterval: 15000,
        trackStuckThresholdMs: 45000,
        eventTimeoutMs: 3333,
        zombieThresholdMs: 99999,
        sponsorblock: {
            enabled: true,
            api: 'x',
            categories: [],
            actionTypes: ['skip'],
            skipMarginMs: 1
        },
        filters: { enabled: { tremolo: true } },
        audio: { quality: 'high' },
        voiceReceive: { enabled: true, format: 'opus' },
        mix: {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5,
            autoCleanup: true
        },
        enableTrackStreamEndpoint: true,
        enableLoadStreamEndpoint: true,
        dosProtection: { enabled: true },
        rateLimit: { enabled: true },
        metrics: { enabled: true },
        enableHoloTracks: true,
        cluster: {
            commandTimeout: 6000,
            fastCommandTimeout: 4000
        }
    };
    const migrated = migrateConfig(legacy);
    assert.equal(migrated.search.maxResults, 25);
    assert.deepEqual(migrated.search.defaultSource, ['youtube']);
    assert.deepEqual(migrated.search.unifiedSources, ['youtube', 'soundcloud']);
    assert.equal(migrated.search.resolveExternalLinks, true);
    assert.equal(migrated.search.fetchChannelInfo, true);
    assert.equal(migrated.playback.maxPlaylistLength, 777);
    assert.equal(migrated.playback.playerUpdateInterval, 3000);
    assert.equal(migrated.playback.statsUpdateInterval, 15000);
    assert.equal(migrated.playback.trackStuckThresholdMs, 45000);
    assert.equal(migrated.playback.eventTimeoutMs, 3333);
    assert.equal(migrated.playback.zombieThresholdMs, 99999);
    assert.equal(migrated.playback.voiceReceive.enabled, true);
    assert.equal(migrated.api.enableTrackStreamEndpoint, true);
    assert.equal(migrated.api.enableLoadStreamEndpoint, true);
    assert.equal(migrated.experimental.enableHoloTracks, true);
    assert.deepEqual(migrated.network.connection.interval, 12345);
    assert.deepEqual(migrated.network.routePlanner.ipBlocks, ['1.1.1.0/24']);
    assert.equal(migrated.cluster.timeouts?.heavyMs, 6000);
    assert.equal(migrated.cluster.timeouts?.fastMs, 4000);
    assert.equal(migrated.server.password, 'legacy-pass');
});
test('migrateConfig preserves explicit hierarchical values over legacy duplicates', () => {
    const hybrid = {
        server: { password: 'server-password' },
        trustProxy: true,
        maxSearchResults: 10,
        search: { maxResults: 50 },
        cluster: {
            commandTimeout: 6000,
            fastCommandTimeout: 4000,
            timeouts: { heavyMs: 9000, fastMs: 7000 }
        },
        network: {
            proxy: {
                enabled: true,
                strategy: 'RoundRobin',
                retries: 1,
                timeout: 1,
                shuffleOnStart: false,
                list: []
            }
        }
    };
    const migrated = migrateConfig(hybrid);
    assert.equal(migrated.server.password, 'server-password');
    assert.equal(migrated.search.maxResults, 50);
    assert.equal(migrated.cluster.timeouts?.heavyMs, 9000);
    assert.equal(migrated.cluster.timeouts?.fastMs, 7000);
    assert.equal(migrated.network.proxy.enabled, true);
});
test('migrateConfig fills required compatibility defaults', () => {
    const minimalLegacy = {
        server: { password: 'abc' },
        cluster: { commandTimeout: 1000, fastCommandTimeout: 2000 }
    };
    const migrated = migrateConfig(minimalLegacy);
    assert.equal(migrated.server.password, 'abc');
    assert.equal(migrated.cluster.timeouts?.heavyMs, 1000);
    assert.equal(migrated.cluster.timeouts?.fastMs, 2000);
    assert.equal(migrated.network.proxy.enabled, false);
    assert.deepEqual(migrated.network.proxy.list, []);
});
test('migrateConfig keeps vanilla default config valid', () => {
    const migrated = migrateConfig(defaultConfig);
    assert.equal(migrated.server.host, defaultConfig.server.host);
    assert.equal(migrated.search.maxResults, defaultConfig.search.maxResults);
    assert.equal(migrated.playback.playerUpdateInterval, defaultConfig.playback.playerUpdateInterval);
    assert.equal(migrated.api.enableTrackStreamEndpoint, defaultConfig.api.enableTrackStreamEndpoint);
    assert.equal(migrated.server.password, defaultConfig.server.password);
});
test('toTsLiteral generates idiomatic TypeScript formatting', () => {
    const input = {
        a: 1,
        'b-c': 'val',
        d: [1, { e: true }],
        f: null,
        g: "'quotes'"
    };
    const expected = `{
  a: 1,
  'b-c': 'val',
  d: [
    1,
    {
      e: true
    }
  ],
  f: null,
  g: '\\'quotes\\''
}`;
    assert.equal(toTsLiteral(input), expected);
});
